'use strict';

const utils = require('@iobroker/adapter-core');
const bluelinky = require('bluelinky');
const Json2iob = require('./lib/json2iob');

const adapterIntervals = {}; //halten von allen Intervallen
let request_count = 0; // halbstündig sollte als Standardeinstellung reichen (zu häufige Abfragen entleeren die Batterie spürbar)
const max_request = 400;
let client;
const positionUrlConst = 'https://maps.google.com/maps?z=15&t=m&q=loc:';

let slow_charging;
let fast_charging;

const todayDriveEmpty = '{"period":0,"rawDate":"20230608","date":"2023-06-07T00:00:01.000Z","consumption":{"total":0,"engine":0,"climate":0,"devices":0,"battery":0},"regen":0,"distance":0}';

const POSSIBLE_CHARGE_LIMIT_VALUES = [50, 60, 70, 80, 90, 100];


/* seat states from bluelinky
1: Unknown
2: Off
3: Low Cool
4: Medium Cool
5: Full Cool
6: Low Heat
7: Medium Heat
8: High Heat
*/

class Bluelink extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'bluelink',
        });

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        // this.on('objectChange', this.onObjectChange.bind(this));
        // this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.vehiclesDict = {};
        this.batteryState12V = {};
        this.vehicles = [];
        this.json2iob = new Json2iob(this);
        adapterIntervals.evHistoryInterval = null;
        this.countError = 0;        
    }

    //Start Adapter
    async onReady() {
        //first check account settings
        this.setState('info.connection', false, true);
        let loginGo = true;

        if (this.config.motor == 'GAS')
        {
            this.config.evHistory = false;
            this.config.request = 1;
        }

        if (this.config.request < 1 || this.config.request > max_request) {
            this.log.warn('Request is invalid got to default ' + request_count);
        } else {
            request_count = this.config.request;
        }

        if (this.config.username == '') {
            this.log.error('Check Settings. No Username set');
            loginGo = false;
        }
        if (this.config.motor == '') {
            this.log.error('Check Settings. Enginetype is not defined ');
            loginGo = false;
        }

        if (loginGo) {
            await this.login();
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            clearTimeout(adapterIntervals.readAllStates);
            clearInterval(adapterIntervals.evHistoryInterval);
            this.log.info('Adapter bluelink cleaned up everything...');
            callback();
        } catch (e) {
            callback();
        }
    }

    async onStateChange(id, state) {
        if (state) {
            if (id.indexOf('.control.') === -1) {
                return;
            }
            this.log.debug('New Event for state: ' + JSON.stringify(state));
            this.log.debug('ID: ' + JSON.stringify(id));

	        let response = '';
            const vin = id.split('.')[2];
            const vehicle = this.vehiclesDict[vin];
            let tmpControl = id.split('.')[5];

            if (tmpControl == undefined) {  // wenn undefined nimm ebene höher
		        tmpControl = id.split('.')[4];
            }

            let force_update_obj = await this.getStateAsync(`${vin}.control.force_update`);
	        try {
	            switch (tmpControl) {
	                case 'force_checkDriveInfo':
	                    this.log.info('force checkDriveInfo ');
	                    await this.readStatusVin(vehicle, force_update_obj.val);
	                    this.driveHistory(vehicle);                    
	                    break;
	                case 'lock':
	                    this.log.info('Starting lock for vehicle');
	                    response = await vehicle.lock();
	                    this.log.debug(JSON.stringify(response));
	                    break;
	                case 'unlock':
	                    this.log.info('Starting unlock for vehicle');
	                    response = await vehicle.unlock();
	                    this.log.debug(JSON.stringify(response));
	                    break;
	                case 'start':
	                    this.log.info('Starting clima for vehicle');
	                    let airTempC = await this.getStateAsync(`${vin}.control.clima.set.airTemp`);
	                    let defrost = await this.getStateAsync(`${vin}.control.clima.set.defrost`);
	                    let heating = await this.getStateAsync(`${vin}.control.clima.set.heating`);
	                    try {
                            response = await vehicle.start({
                                airCtrl: true,
                                hvacType: 0,
                                igniOnDuration: 10,
                                temperature: airTempC.val,
                                defrost: defrost.val,
                                heating1: heating.val,
                                username: this.config.username,
                                vin: vin,
        				    });
				    
	                       this.log.debug(JSON.stringify(response));
	                    } catch (err) {
	                        this.log.error(err);
	                    }
	                    break;
	                case 'stop':
	                    this.log.info('Stop clima for vehicle');
	                    response = await vehicle.stop();
	                    this.log.debug(JSON.stringify(response));
	                    break;
	                case 'force_refresh_from_server':
	                    this.log.info('Forcing refresh from Server');
	                    await this.readStatusVin(vehicle,false);
	                    break;
	                case 'force_refresh_from_car':
	                    this.log.info('Forcing refresh from Car');
	                    await this.readStatusVin(vehicle,true);
	                    break;
	                case 'force_refresh':
	                    this.log.info('Forcing refresh');
	                    await this.readStatusVin(vehicle, force_update_obj.val);
	                    break;
	                case 'force_update':
	                    if (force_update_obj.val) {
	                        this.log.info('Update method for ' + vin + ' changed to "directly from the car"');
	                    } else {
	                        this.log.info('Update method for ' + vin + ' changed to "from the server"');
	                    }
	                    break;
                    case 'force_login':
                        clearTimeout(adapterIntervals.readAllStates);
                        clearInterval(adapterIntervals.evHistoryInterval);
                        this.login();
                        break;

	                case 'charge':
	                    this.log.info('Start charging');
	                    response = await vehicle.startCharge();
			            this.log.debug(JSON.stringify(response));
	                    break;case 'charge_stop':
	                    this.log.info('Stop charging');
	                    response = await vehicle.stopCharge();
			            this.log.debug(JSON.stringify(response));
	                    break;

                    case 'charge_limit_fast':
			        case 'charge_limit_slow':
	                    if (!state.ack) {
	                        if (!POSSIBLE_CHARGE_LIMIT_VALUES.includes(state.val)) {
	                            this.log.error(`Charge target values are limited to ${POSSIBLE_CHARGE_LIMIT_VALUES.join(', ')}`);
	                        } else {
	                            const charge_option = { fast: fast_charging, slow: slow_charging };
	                            if (tmpControl == 'charge_limit_fast') {
					                this.log.info('Set new charging options charge_limit_fast');
	                                //set fast charging
	                                let charge_limit_slow = await this.getStateAsync(`${vin}.control.charge_limit_slow`);
	                                charge_option.fast = state.val;
                					charge_option.slow = charge_limit_slow.val;
	                            } 
				                if (tmpControl == 'charge_limit_slow') {
					                this.log.info('Set new charging options charge_limit_slow');
	                                //set slow charging
	                                let charge_limit_fast = await this.getStateAsync(`${vin}.control.charge_limit_fast`);
	                                charge_option.slow = state.val;
                					charge_option.fast = charge_limit_fast.val;
	                            }
	                            response = await vehicle.setChargeTargets(charge_option);
	                            this.log.debug(JSON.stringify(response));
	                        }
	                    }
	                    break;
                    default:
	                    this.log.error('No command for Control found');
	            }
	        } catch(err) {
	    	    this.log.error('Error onStateChange ' + err);
	        }
        }
    }

    /**
     * Funktion to login in bluelink / UVO
     */
    async login() {
        try {
            this.log.info('Login to api');

            const loginOptions = {
                username: this.config.username,
                password: this.config.client_secret,
                pin: this.config.client_secret_pin,
                brand: this.config.brand,
                region: 'EU', //set over GUI next time
                language:  this.config.language,
            };

            client = new bluelinky(loginOptions);

            client.on('ready', async (vehicles) => {
                this.setState('info.connection', true, true);
                // wir haben eine Verbindung und haben Autos
                this.log.info(vehicles.length + ' Vehicles found');
                this.log.debug(JSON.stringify(vehicles, this.getCircularReplacer()));

                this.vehicles = vehicles;

                for (const vehicle of vehicles) {
                    const vin = vehicle.vehicleConfig.vin;
                    this.vehiclesDict[vin] = vehicle;
                    await this.setObjectNotExistsAsync(vin, {
                        type: 'device',
                        common: {
                            name: vehicle.vehicleConfig.nickname,
                        },
                        native: {},
                    });

                    await this.setControlObjects(vin);
                    await this.setStatusObjects(vin);

                    await this.setObjectNotExistsAsync(`${vin}.general`, {
                        type: 'channel',
                        common: {
                            name: 'General Information',
                        },
                        native: {},
                    });
                    await this.json2iob.parse(`${vin}.general`, vehicle.vehicleConfig);

                    if (this.config.evHistory && this.config.motor != 'GAS') {
                        try {
                            await this.driveHistory(vehicle);

                            adapterIntervals.evHistoryInterval = setInterval(() => {
                                this.receiveEVInformation(vehicle);
                            }, 60 * 60 * 1000); // check einmal die stunde nur intern
                        } catch (error) {
                            this.log.error('Error in receiveEVInformation');
                        }
                    }
                    await this.setStateAsync(`${vin}.error_counter`, 0, true);
                }
                this.countError = 0;

                //read all infos
                await this.readStatus();
                //clean legacy states
                this.cleanObjects();
            });

            client.on('error', async (err) => {
                // something went wrong with login
                this.log.error(err);
                this.log.error('Server is not available or login credentials are wrong');
                this.log.error('next auto login attempt in 1 hour or restart adapter manual');

                let requestTimeout = setTimeout(async () => {
                    this.login();
                }, 1000 * 60 * 60);  // warte 1 stunde
            });
        } catch (error) {
            this.log.error('Error in login/on function');
            if (typeof error === 'string') {
                this.log.error(error);
            } else if (error instanceof Error) {
                this.log.error(error.message);
            }
        }
    }

    //read new sates from vehicle
    async readStatus(force = false) {
        //read new verhicle status
        for (const vehicle of this.vehicles) {
          const vin = vehicle.vehicleConfig.vin;
          let force_update_obj = await this.getStateAsync(`${vin}.control.force_update`);
          this.log.debug('Read new status from api for ' + vin);
          let batteryControlState12V = await this.getStateAsync(`${vin}.control.batteryControlState12V`);

          if (this.batteryState12V[vin] && this.batteryState12V[vin] < batteryControlState12V.val && force_update_obj.val) {
              this.log.warn('12V Battery state is low: ' + this.batteryState12V[vin] + '%. Recharge to prevent damage!');
              if (this.config.protectAgainstDeepDischarge && !force) {
                  this.log.warn('Auto Refresh is disabled, only use force refresh to reenable refresh if you are willing to risk your battery');
                  continue;
              }
          }                      
          await this.readStatusVin(vehicle,force_update_obj.val);
        }

        //set ne cycle
        if (force) {
            clearTimeout(adapterIntervals.readAllStates);
        }
        adapterIntervals.readAllStates = setTimeout(this.readStatus.bind(this), ((24 * 60) / request_count) * 60000);
    }

    // force_update = true Daten vom Auto
    // force_update = false vom server

    async readStatusVin(vehicle, force_update) {
      const vin = vehicle.vehicleConfig.vin;
      try {
          let newStatus;

          if(force_update) {
              this.log.info('Read new update for ' + vin + ' directly from the car');
          } else {
              this.log.info('Read new update for ' + vin + ' from the server');
          }

          try {
              newStatus = await vehicle.fullStatus({
                  refresh: force_update,
                  parsed: true,
              });
              //set all values
              this.log.debug('Set new full status for ' + vin);
              this.log.debug('RAW ' + JSON.stringify(newStatus));

              // raw data
              await this.json2iob.parse(vin + '.vehicleStatusRaw', newStatus);

              await this.setNewFullStatus(newStatus, vin);
              
              if (newStatus.vehicleStatus && newStatus.vehicleStatus.battery && newStatus.vehicleStatus.battery.batSoc) {
                  this.log.debug('Set ' + newStatus.vehicleStatus.battery.batSoc + ' battery state for ' + vin);
                  this.batteryState12V[vin] = newStatus.vehicleStatus.battery.batSoc;
              }

          } catch (error) {
              if (typeof error === 'string') {
                  this.log.error('Error on API-Request GetFullStatus');
                  this.log.error(error);
              } else {
                  //if(error.source.statusCode == 503) {
                  this.log.info('Error on API-Full-Status - Fallback GetNormalStatus');

                  //Abfrage Full hat nicht geklappt. Haben wir einen Fallback?
                  newStatus = await vehicle.status({
                      refresh: force_update,
                      parsed: true,
                  });
                  this.log.debug('Set new GetNormalStatus for ' + vin);
                  this.log.debug(JSON.stringify(newStatus));

                  await this.setNewStatus(newStatus, vin);
                  if (newStatus.engine && newStatus.engine.batteryCharge12v) {
                      this.log.debug('Set ' + newStatus.engine.batteryCharge12v + ' battery state for ' + vin);
                      this.batteryState12V[vin] = newStatus.engine.batteryCharge12v;
                  }
              }
          }

          //Abfrage war erfolgreich, lösche ErrorCounter
          this.countError = 0;
          await this.setStateAsync(`${vin}.error_counter`, this.countError, true);
          this.log.info('Update for ' + vin + ' successfull');
          // last update
          await this.setStateAsync(`${vin}.lastInfoUpdate`, Number(Date.now()), true);

      } catch (error) {
          this.countError += 1;  // add 1

          this.log.error('Error on API-Request Status, ErrorCount:' + this.countError);
          if (typeof error === 'string') {
              this.log.error(error);
          } else if (error instanceof Error) {
              this.log.error(error.message);
          }
      }

      await this.setStateAsync(`${vin}.error_counter`, this.countError, true);

      if (this.countError > this.config.errorCounter) {
          //Error counter over x erros, restart Adapter to fix te API Token
          this.restart();
      }
    }

    async receiveEVInformation(vehicle) {
        const tickHour = new Date().getHours(); // um 23 uhr daten festschreiben

        if (tickHour == 23) {
		this.log.info('DriveHistory Update for ' + vehicle.vehicleConfig.vin);
            	this.driveHistory(vehicle);    
        } 
    }
    
    async driveHistory(vehicle) {
        try {
            const driveHistory = await vehicle.driveHistory();

            const vin = vehicle.vehicleConfig.vin;
        
            if (driveHistory.cumulated[0].regen != undefined) {
                this.log.debug('driveHistory-Data: ' + JSON.stringify(driveHistory));
                await this.setObjectNotExistsAsync(vin + '.driveHistory', {
                    type: 'channel',
                    common: {
                        name: 'drive history',
                    },
                    native: {},
                });
                
                await this.json2iob.parse(vin + '.driveHistory', driveHistory, { preferedArrayName: 'rawDate' });
                
                this.todayOnly(vehicle, vin, driveHistory);        
                
                const monthlyReport = await vehicle.monthlyReport();
                await this.setObjectNotExistsAsync(vin + '.monthlyReport', {
                    type: 'channel',
                    common: {
                        name: 'monthly report',
                    },
                    native: {},
                });
                await this.json2iob.parse(vin + '.monthlyReport', monthlyReport);
                const tripInfo = await vehicle.tripInfo({ year: new Date().getFullYear(), month: new Date().getMonth() + 1 });
                await this.setObjectNotExistsAsync(vin + '.tripInfo', {
                    type: 'channel',
                    common: {
                        name: 'trip information',
                    },
                    native: {},
                });
                await this.json2iob.parse(vin + '.tripInfo', tripInfo);
            }
        } catch (error) {
            this.log.error('EV History fetching failed');
            if (typeof error === 'string') {
                this.log.error(error);
            } else if (error instanceof Error) {
                this.log.error(error.message);
            }
        }
    }
    
    async todayOnly(vehicle, vin, driveHistory) {
        let onlyHistory = driveHistory.history;
        const today = this.getToday();

        for (const lpEntry in onlyHistory) {
            let res =  onlyHistory[lpEntry];
            this.log.debug('check Today ' + today + ' ' + res.rawDate);
            if (today == res.rawDate) {          // suche heutiges Datum
                await this.setObjectNotExistsAsync(vin + '.driveHistory.today', {
                    type: 'channel',
                    common: {
                        name: 'today report',
                    },
                    native: {},
                });
                this.log.debug('write Today ' + res);
                await this.json2iob.parse(vin + '.driveHistory.today', res);
                break;
            }
        }
    }
    
    getToday() {
        var today = new Date();
        const yyyy = today.getFullYear();
        let mm = today.getMonth() + 1;
        let dd = today.getDate();

        if (dd < 10) dd = '0' + dd;
        if (mm < 10) mm = '0' + mm;

        return yyyy + '' + mm + '' + dd;
    }
    
    //Set new values to ioBroker for normal Status
    async setNewStatus(newStatus, vin) {
        //chassis
        await this.setStateAsync(vin + '.vehicleStatus.doorLock', { val: newStatus.chassis.locked, ack: true });
        await this.setStateAsync(vin + '.vehicleStatus.trunkOpen', { val: newStatus.chassis.trunkOpen, ack: true });
        await this.setStateAsync(vin + '.vehicleStatus.hoodOpen', { val: newStatus.chassis.hoodOpen, ack: true });

        //chassis/doors
        this.checkDoor(vin, newStatus.chassis.openDoors);

        //climate
        await this.setStateAsync(vin + '.vehicleStatus.airCtrlOn', { val: newStatus.climate.active, ack: true });
        await this.setStateAsync(vin + '.vehicleStatus.airTemp', { val: newStatus.climate.temperatureSetpoint, ack: true });


	let steerWheelHeat = newStatus.climate.steeringwheelHeat;
	    
	if (typeof steerWheelHeat == 'number') {
		steerWheelHeat = steerWheelHeat == 0 ? false : true;
	}
	    
        await this.setStateAsync(vin + '.vehicleStatus.steerWheelHeat', { val: steerWheelHeat, ack: true });
        //await this.setStateAsync(vin + '.vehicleStatus.sideBackWindowHeat', { val: newStatus.climate.sideBackWindowHeat, ack: true });

        //Engine
        await this.setStateAsync(vin + '.vehicleStatus.battery.soc', { val: newStatus.engine.batteryChargeHV, ack: true });
        await this.setStateAsync(vin + '.vehicleStatus.battery.charge', { val: newStatus.engine.charging, ack: true });
        await this.setStateAsync(vin + '.vehicleStatus.battery.soc-12V', { val: newStatus.engine.batteryCharge12v, ack: true });
    }

    //Set new values to ioBroker
    async setNewFullStatus(newStatus, vin) {
        await this.setStateAsync(vin + '.vehicleStatus.airCtrlOn', { val: newStatus.vehicleStatus.airCtrlOn, ack: true });
        await this.setStateAsync(vin + '.vehicleStatus.airTemp', {
            val: this.getCelsiusFromTempcode(newStatus.vehicleStatus.airTemp.value),
            ack: true,
        });

        //Charge

        //Bei Kia sind die Werte in einer targetSOClist
        if (this.config.motor == 'GAS') {
            await this.setStateAsync(vin + '.vehicleStatus.dte', {val: newStatus.vehicleStatus.dte.value, ack: true});
        } else {
            if (newStatus.vehicleStatus.evStatus.reservChargeInfos.targetSOClist != undefined) {
                if (newStatus.vehicleStatus.evStatus.reservChargeInfos.targetSOClist[0].plugType == 1) {
                    //Slow  = 1  -> Index 0 ist slow
                    await this.setStateAsync(vin + '.control.charge_limit_slow', {
                        val: newStatus.vehicleStatus.evStatus.reservChargeInfos.targetSOClist[0].targetSOClevel,
                        ack: true,
                    });
                    slow_charging = newStatus.vehicleStatus.evStatus.reservChargeInfos.targetSOClist[0].targetSOClevel;
                    await this.setStateAsync(vin + '.control.charge_limit_fast', {
                        val: newStatus.vehicleStatus.evStatus.reservChargeInfos.targetSOClist[1].targetSOClevel,
                        ack: true,
                    });
                    fast_charging = newStatus.vehicleStatus.evStatus.reservChargeInfos.targetSOClist[1].targetSOClevel;
                } else {
                    //fast  = 0  -> Index 0 ist fast
                    await this.setStateAsync(vin + '.control.charge_limit_slow', {
                        val: newStatus.vehicleStatus.evStatus.reservChargeInfos.targetSOClist[1].targetSOClevel,
                        ack: true,
                    });
                    slow_charging = newStatus.vehicleStatus.evStatus.reservChargeInfos.targetSOClist[1].targetSOClevel;
                    await this.setStateAsync(vin + '.control.charge_limit_fast', {
                        val: newStatus.vehicleStatus.evStatus.reservChargeInfos.targetSOClist[0].targetSOClevel,
                        ack: true,
                    });
                    fast_charging = newStatus.vehicleStatus.evStatus.reservChargeInfos.targetSOClist[0].targetSOClevel;
                }
            }

            //Nur für Elektro Fahrzeuge - Battery
            await this.setStateAsync(vin + '.vehicleStatus.dte', {
                val: newStatus.vehicleStatus.evStatus.drvDistance[0].rangeByFuel.totalAvailableRange.value,
                ack: true,
            });
            await this.setStateAsync(vin + '.vehicleStatus.evModeRange', {
                val: newStatus.vehicleStatus.evStatus.drvDistance[0].rangeByFuel.evModeRange.value,
                ack: true,
            });
            if (newStatus.vehicleStatus.evStatus.drvDistance[0].rangeByFuel.gasModeRange != undefined) {
                //Only for PHEV
                await this.setStateAsync(vin + '.vehicleStatus.gasModeRange', {
                    val: newStatus.vehicleStatus.evStatus.drvDistance[0].rangeByFuel.gasModeRange.value,
                    ack: true,
                });
            }

            await this.setStateAsync(vin + '.vehicleStatus.battery.soc', { val: newStatus.vehicleStatus.evStatus.batteryStatus, ack: true });
            await this.setStateAsync(vin + '.vehicleStatus.battery.charge', { val: newStatus.vehicleStatus.evStatus.batteryCharge, ack: true });
            await this.setStateAsync(vin + '.vehicleStatus.battery.plugin', { val: newStatus.vehicleStatus.evStatus.batteryPlugin, ack: true });

            //Ladezeit anzeigen, da noch nicht klar welche Werte
            await this.setStateAsync(vin + '.vehicleStatus.battery.minutes_to_charged', {
                val: newStatus.vehicleStatus.evStatus.remainTime2.atc.value,
                ack: true,
            });
            this.log.debug('Folgende Ladezeiten Moeglichkeiten wurden gefunden:');
            this.log.debug(JSON.stringify(newStatus.vehicleStatus.evStatus.remainTime2));
        }

        // nur für Kia
        if (newStatus.vehicleStatus.battery != undefined) {
            await this.setStateAsync(vin + '.vehicleStatus.battery.soc-12V', { val: newStatus.vehicleStatus.battery.batSoc, ack: true });
            await this.setStateAsync(vin + '.vehicleStatus.battery.state-12V', { val: newStatus.vehicleStatus.battery.batState, ack: true });
        }

        //Location
        if (newStatus.vehicleLocation != undefined) {
            //#47 KIA Seed have no vehicleLocation
            if (newStatus.vehicleLocation.coord != undefined) {
                const latitude = newStatus.vehicleLocation.coord.lat;
                const longitude = newStatus.vehicleLocation.coord.lon;
                const positionUrl = `${positionUrlConst}${latitude}+${longitude}`;

                await this.setStateAsync(vin + '.vehicleLocation.lat', { val: latitude, ack: true });
                await this.setStateAsync(vin + '.vehicleLocation.lon', { val: longitude, ack: true });
                await this.setStateAsync(vin + '.vehicleLocation.speed', { val: newStatus.vehicleLocation.speed.value, ack: true });
                await this.setStateAsync(vin + '.vehicleLocation.position_url', { val: positionUrl, ack: true });

            }
        }

        //Odometer
        await this.setStateAsync(vin + '.odometer.value', { val: newStatus.odometer.value, ack: true });
        await this.setStateAsync(vin + '.odometer.unit', { val: newStatus.odometer.unit, ack: true });

        //open / door
        await this.setStateAsync(vin + '.vehicleStatus.doorLock', { val: newStatus.vehicleStatus.doorLock, ack: true });
        await this.setStateAsync(vin + '.vehicleStatus.trunkOpen', { val: newStatus.vehicleStatus.trunkOpen, ack: true });
        await this.setStateAsync(vin + '.vehicleStatus.hoodOpen', { val: newStatus.vehicleStatus.hoodOpen, ack: true });

        this. checkDoor(vin, newStatus.vehicleStatus.doorOpen);

        //status parameter
        await this.setStateAsync(vin + '.vehicleStatus.airCtrlOn', { val: newStatus.vehicleStatus.airCtrlOn, ack: true });
        await this.setStateAsync(vin + '.vehicleStatus.smartKeyBatteryWarning', { val: newStatus.vehicleStatus.smartKeyBatteryWarning, ack: true });
        await this.setStateAsync(vin + '.vehicleStatus.washerFluidStatus', { val: newStatus.vehicleStatus.washerFluidStatus, ack: true });
        await this.setStateAsync(vin + '.vehicleStatus.breakOilStatus', { val: newStatus.vehicleStatus.breakOilStatus, ack: true });

	let steerWheelHeat = newStatus.vehicleStatus.steerWheelHeat;
	    
	if (typeof steerWheelHeat == 'number') {
		steerWheelHeat = steerWheelHeat == 0 ? false : true;
	}
        await this.setStateAsync(vin + '.vehicleStatus.steerWheelHeat', { val: steerWheelHeat, ack: true });    
	await this.setStateAsync(vin + '.vehicleStatus.sideBackWindowHeat', { val: newStatus.vehicleStatus.sideBackWindowHeat, ack: true });
    }

    async checkDoor(vin, doors) {
        if (doors != undefined) {
            let frontLeft = doors.frontLeft;
            let frontRight = doors.frontRight;
            let backLeft = doors.backLeft;
            let backRight = doors.backRight;

            // HEV hyundai send 0 but we need boolean
            if (typeof frontLeft == 'number') {
                frontLeft = frontLeft == 0 ? false : true;
            }

            if (typeof frontRight == 'number') {
                frontRight = frontRight == 0 ? false : true;
            }

            if (typeof backLeft == 'number') {
                backLeft = backLeft == 0 ? false : true;
            }

            if (typeof backRight == 'number') {
                backRight = backRight == 0 ? false : true;
            }

            await this.setStateAsync(vin + '.vehicleStatus.doorOpen.frontLeft', { val: frontLeft, ack: true });
            await this.setStateAsync(vin + '.vehicleStatus.doorOpen.frontRight', { val: frontRight, ack: true });
            await this.setStateAsync(vin + '.vehicleStatus.doorOpen.backLeft', { val: backLeft, ack: true });
            await this.setStateAsync(vin + '.vehicleStatus.doorOpen.backRight', { val: backRight, ack: true });
        }
    }

    /**
     * Functions to create the ioBroker objects
     */

    async setControlObjects(vin) {         
        await this.setObjectNotExistsAsync(vin + '.control.charge', {
            type: 'state',
            common: {
                name: 'Start charging',
                type: 'boolean',
                role: 'button',
                read: true,
                write: true,
		def: true,
            },
            native: {},
        });
        this.subscribeStates(vin + '.control.charge');

        await this.setObjectNotExistsAsync(vin + '.control.charge_stop', {
            type: 'state',
            common: {
                name: 'Stop charging',
                type: 'boolean',
                role: 'button',
                read: true,
                write: true,
		def: true,
            },
            native: {},
        });
        this.subscribeStates(vin + '.control.charge_stop');

        await this.setObjectNotExistsAsync(vin + '.control.lock', {
            type: 'state',
            common: {
                name: 'Lock the vehicle',
                type: 'boolean',
                role: 'button',
                read: true,
                write: true,
		def: true,
            },
            native: {},
        });
        this.subscribeStates(vin + '.control.lock');

        await this.setObjectNotExistsAsync(vin + '.control.unlock', {
            type: 'state',
            common: {
                name: 'Unlock the vehicle',
                type: 'boolean',
                role: 'button',
                read: true,
                write: true,
		def: true,
            },
            native: {},
        });
        this.subscribeStates(vin + '.control.unlock');

        if (this.config.motor == 'EV') {
		await this.setObjectNotExistsAsync(vin + '.control.force_checkDriveInfo', {
	            type: 'state',
	            common: {
	                name: 'Force load Drive Infos',
	                type: 'boolean',
	                role: 'button',
	                read: true,
	                write: true,
			def: true,
	            },
	            native: {},
	        });
	        this.subscribeStates(vin + '.control.force_checkDriveInfo');
            await this.setObjectNotExistsAsync(vin + '.control.clima.start', {
                type: 'state',
                common: {
                    name: 'Start clima for the vehicle',
                    type: 'boolean',
                    role: 'button',
                    read: true,
                    write: true,
		   def: true,
                },
                native: {},
            });
            this.subscribeStates(vin + '.control.clima.start');

            await this.setObjectNotExistsAsync(vin + '.control.clima.set.defrost', {
                type: 'state',
                common: {
                    name: 'set defrost function for clima',
                    type: 'boolean',
                    role: 'state',
                    read: true,
                    write: true,
                    def: false,
                },
                native: {},
            });

            await this.setObjectNotExistsAsync(vin + '.control.clima.set.heating', {
                type: 'state',
                common: {
                    name: 'set heating  1 or 0',
                    type: 'number',
                    role: 'state',
                    read: true,
                    write: true,
                    def: 0,
                },
                native: {},
            });

            await this.setObjectNotExistsAsync(vin + '.control.clima.set.airTemp', {
                type: 'state',
                common: {
                    name: 'set Vehicle air tempereature',
                    type: 'number',
                    role: 'indicator',
                    read: true,
                    write: true,
                    def: 18,
                },
                native: {},
            });

            await this.setObjectNotExistsAsync(vin + '.control.clima.stop', {
                type: 'state',
                common: {
                    name: 'Stop clima for the vehicle',
                    type: 'boolean',
                    role: 'button',
                    read: true,
                    write: true,
		    def: true,
                },
                native: {},
            });
            this.subscribeStates(vin + '.control.clima.stop');
        }
        await this.setObjectNotExistsAsync(vin + '.control.force_refresh_from_car', {
            type: 'state',
            common: {
                name: 'Force refresh vehicle status from car',
                type: 'boolean',
                role: 'button',
                read: true,
                write: true,
		def: true,
            },
            native: {},
        });
        this.subscribeStates(vin + '.control.force_refresh_from_car');

        await this.setObjectNotExistsAsync(vin + '.control.force_refresh_from_server', {
            type: 'state',
            common: {
                name: 'Force refresh vehicle status from server',
                type: 'boolean',
                role: 'button',
                read: true,
                write: true,
		def: true,
            },
            native: {},
        });
        this.subscribeStates(vin + '.control.force_refresh_from_server');

        await this.setObjectNotExistsAsync(vin + '.control.force_refresh', {
            type: 'state',
            common: {
                name: 'Force refresh vehicle status',
                type: 'boolean',
                role: 'button',
                read: true,
                write: true,
		def: true,
            },
            native: {},
        });
        this.subscribeStates(vin + '.control.force_refresh');

        await this.setObjectNotExistsAsync(vin + '.control.force_update', {
            type: 'state',
            common: {
                name: 'true = car, false = server',
                type: 'boolean',
                role: 'state',
                read: true,
                write: true,
                def: false,
            },
            native: {},
        });
        this.subscribeStates(vin + '.control.force_update');

        await this.setObjectNotExistsAsync(vin + '.control.force_login', {
            type: 'state',
            common: {
                name: 'Force login',
                type: 'boolean',
                role: 'button',
                read: true,
                write: true,
                def: true,
            },
            native: {},
        });
        this.subscribeStates(vin + '.control.force_login');

        await this.setObjectNotExistsAsync(vin + '.control.batteryControlState12V', {
            type: 'state',
            common: {
                name: 'Set battery monitoring',
                type: 'number',
                role: 'state',
                read: true,
                write: true,
                def: 65,
            },
            native: {},
        });
        this.subscribeStates(vin + '.control.batteryControlState12V');
    }

    async setStatusObjects(vin) {
        await this.setObjectNotExistsAsync(`${vin}.lastInfoUpdate`, {
            type: 'state',
            common: {
                name: 'Date/Time of last information update',
                type: 'number',
                role: 'value.time',
                read: true,
                write: false
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${vin}.error_counter`, {
            type: 'state',
            common: {
                name: 'error_counter',
                type: 'number',
                role: 'state',
                read: true,
                write: false,
                def: 0,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(vin + '.vehicleStatusRaw', {
            type: 'channel',
            common: {
                name: 'Unformatted vehicle status',
            },
            native: {},
        });


        //Bereicht vehicleStatus
        await this.setObjectNotExistsAsync(vin + '.vehicleStatus.doorLock', {
            type: 'state',
            common: {
                name: 'Vehicle doors locked',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false,		
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(vin + '.vehicleStatus.trunkOpen', {
            type: 'state',
            common: {
                name: 'Trunk open',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(vin + '.vehicleStatus.hoodOpen', {
            type: 'state',
            common: {
                name: 'Hood open',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false,
            },
            native: {},
        });

        //Doors open
        await this.setObjectNotExistsAsync(vin + '.vehicleStatus.doorOpen.frontLeft', {
            type: 'state',
            common: {
                name: 'Door open front left open',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(vin + '.vehicleStatus.doorOpen.frontRight', {
            type: 'state',
            common: {
                name: 'Door open front right open',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(vin + '.vehicleStatus.doorOpen.backLeft', {
            type: 'state',
            common: {
                name: 'Door open back left open',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(vin + '.vehicleStatus.doorOpen.backRight', {
            type: 'state',
            common: {
                name: 'Door open back right left open',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false,
            },
            native: {},
        });       
	    
	await this.setObjectNotExistsAsync(vin + '.vehicleStatus.airCtrlOn', {
            type: 'state',
            common: {
                name: 'Vehicle air control',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(vin + '.vehicleStatus.airTemp', {
            type: 'state',
            common: {
                name: 'Vehicle air tempereature',
                type: 'number',
                role: 'indicator',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(vin + '.vehicleStatus.smartKeyBatteryWarning', {
            type: 'state',
            common: {
                name: 'Smart key battery Warning',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(vin + '.vehicleStatus.washerFluidStatus', {
            type: 'state',
            common: {
                name: 'Washer fluid status',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(vin + '.vehicleStatus.breakOilStatus', {
            type: 'state',
            common: {
                name: 'Breal oil status',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(vin + '.vehicleStatus.steerWheelHeat', {
            type: 'state',
            common: {
                name: 'Steer wheel heat',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(vin + '.vehicleStatus.sideBackWindowHeat', {
            type: 'state',
            common: {
                name: 'Side back window heat',
                type: 'number',
                role: 'indicator',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(vin + '.vehicleStatus.dte', {
            type: 'state',
            common: {
                name: 'Vehicle total available range',
                type: 'number',
                role: 'indicator',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(vin + '.vehicleStatus.evModeRange', {
            type: 'state',
            common: {
                name: 'Vehicle total available range for ev',
                type: 'number',
                role: 'indicator',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(vin + '.vehicleStatus.gasModeRange', {
            type: 'state',
            common: {
                name: 'Vehicle total available range for gas',
                type: 'number',
                role: 'indicator',
                read: true,
                write: false,
            },
            native: {},
        });

        //Charge
        await this.setObjectNotExistsAsync(vin + '.control.charge_limit_slow', {
            type: 'state',
            common: {
                name: 'Vehicle charge limit for slow charging',
                type: 'number',
                role: 'indicator',
                read: true,
                write: true,
		def: 100,
            },
            native: {},
        });
        this.subscribeStates(vin + '.control.charge_limit_slow');

        await this.setObjectNotExistsAsync(vin + '.control.charge_limit_fast', {
            type: 'state',
            common: {
                name: 'Vehicle charge limit for fast charging',
                type: 'number',
                role: 'indicator',
                read: true,
                write: true,
		def: 100,
            },
            native: {},
        });
        this.subscribeStates(vin + '.control.charge_limit_fast');

        await this.setObjectNotExistsAsync(vin + '.vehicleStatus.battery.minutes_to_charged', {
            type: 'state',
            common: {
                name: 'Vehicle minutes to charged',
                type: 'number',
                role: 'indicator',
                read: true,
                write: false,

            },
            native: {},
        });

        //Battery
        await this.setObjectNotExistsAsync(vin + '.vehicleStatus.battery.soc', {
            type: 'state',
            common: {
                name: 'Vehicle battery state of charge',
                type: 'number',
                role: 'indicator',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(vin + '.vehicleStatus.battery.charge', {
            type: 'state',
            common: {
                name: 'Vehicle charging',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(vin + '.vehicleStatus.battery.plugin', {
            type: 'state',
            common: {
                name: 'Charger connected (UNPLUGED = 0, FAST = 1, PORTABLE = 2, STATION = 3)',
                type: 'number',
                role: 'indicator',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(vin + '.vehicleStatus.battery.soc-12V', {
            type: 'state',
            common: {
                name: 'Vehicle 12v battery state of charge',
                type: 'number',
                role: 'indicator',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(vin + '.vehicleStatus.battery.state-12V', {
            type: 'state',
            common: {
                name: 'Vehicle 12v battery State',
                type: 'number',
                role: 'indicator',
                read: true,
                write: false,
            },
            native: {},
        });

        //Bereich vehicleLocation
        await this.setObjectNotExistsAsync(vin + '.vehicleLocation.lat', {
            type: 'state',
            common: {
                name: 'Vehicle position latitude',
                type: 'number',
                role: 'value.gps.longitude',
                unit:  '°',
                read: true,
                write: false,
                def: 0,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(vin + '.vehicleLocation.lon', {
            type: 'state',
            common: {
                name: 'Vehicle position longitude',
                type: 'number',
                role: 'value.gps.longitude',
                unit: '°',
                read: true,
                write: false,
                def: 0,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(vin + '.vehicleLocation.speed', {
            type: 'state',
            common: {
                name: 'Vehicle speed',
                type: 'number',
                role: 'value.speed',
                unit: 'km/h',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(vin + '.vehicleLocation.position_url', {
            type: 'state',
            common: {
                name: 'Position URL',
                type: 'string',
                role: 'text.url',
                read: true,
                write: false,
            },
            native: {},
        });


        //Bereich Odometer
        await this.setObjectNotExistsAsync(vin + '.odometer.value', {
            type: 'state',
            common: {
                name: 'Odometer value',
                type: 'number',
                role: 'indicator',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(vin + '.odometer.unit', {
            type: 'state',
            common: {
                name: 'Odometer unit',
                type: 'number',
                role: 'indicator',
                read: true,
                write: false,
            },
            native: {},
        });
    }
    async cleanObjects() {
        const controlState = await this.getObjectAsync('control.charge');

        if (controlState) {
            await this.delObjectAsync('control', { recursive: true });
            await this.delObjectAsync('odometer', { recursive: true });
            await this.delObjectAsync('vehicleLocation', { recursive: true });
            await this.delObjectAsync('vehicleStatus', { recursive: true });
        }
    }

    getCircularReplacer() {
        const seen = new WeakSet();
        return (key, value) => {
            if (typeof value === 'object' && value !== null) {
                if (seen.has(value)) {
                    return;
                }
                seen.add(value);
            }
            return value;
        };
    }

    getCelsiusFromTempcode(tempCode) {
        // create a range
        const tempRange = [];
        //Range for EU
        for (let i = 14; i <= 30; i += 0.5) {
            tempRange.push(i);
        }

        // get the index
        const tempIndex = parseInt(tempCode, 16);

        // return the relevant celsius temp
        return tempRange[tempIndex];
    }
}

if (require.main !== module) {
    module.exports = (options) => new Bluelink(options);
} else {
    // otherwise start the instance directly
    new Bluelink();
}

