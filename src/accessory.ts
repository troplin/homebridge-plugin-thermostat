import {
  AccessoryConfig,
  AccessoryPlugin,
  API,
  Characteristic,
  CharacteristicEventTypes,
  CharacteristicGetCallback,
  CharacteristicProps,
  CharacteristicSetCallback,
  CharacteristicValue,
  HAP,
  Logging,
  Nullable,
  Service,
} from 'homebridge';

/*
 * IMPORTANT NOTICE
 *
 * One thing you need to take care of is, that you never ever ever import anything directly from the "homebridge" module (or the "hap-nodejs" module).
 * The above import block may seem like, that we do exactly that, but actually those imports are only used for types and interfaces
 * and will disappear once the code is compiled to Javascript.
 * In fact you can check that by running `npm run build` and opening the compiled Javascript file in the `dist` folder.
 * You will notice that the file does not contain a `... = require("homebridge");` statement anywhere in the code.
 *
 * The contents of the above import statement MUST ONLY be used for type annotation or accessing things like CONST ENUMS,
 * which is a special case as they get replaced by the actual value and do not remain as a reference in the compiled code.
 * Meaning normal enums are bad, const enums can be used.
 *
 * You MUST NOT import anything else which remains as a reference in the code, as this will result in
 * a `... = require("homebridge");` to be compiled into the final Javascript code.
 * This typically leads to unexpected behavior at runtime, as in many cases it won't be able to find the module
 * or will import another instance of homebridge causing collisions.
 *
 * To mitigate this the {@link API | Homebridge API} exposes the whole suite of HAP-NodeJS inside the `hap` property
 * of the api object, which can be acquired for example in the initializer function. This reference can be stored
 * like this for example and used to access all exported variables and classes from HAP-NodeJS.
 */
let hap: HAP;

/*
 * Initializer function called when the plugin is loaded.
 */
export = (api: API) => {
  hap = api.hap;
  api.registerAccessory('AdvancedThermostat', AdvancedThermostat);
};

class AdvancedThermostat implements AccessoryPlugin {

  private readonly log: Logging;
  private readonly name: string;

  private readonly mainService: Service;
  private readonly informationService: Service;

  private mode: CharacteristicValue;
  private targetTemperature: CharacteristicValue;

  constructor(log: Logging, config: AccessoryConfig, api: API) {
    this.log = log;
    this.name = config.name;

    this.mode = hap.Characteristic.TargetHeatingCoolingState.HEAT;
    this.targetTemperature = 20;

    // create main service
    this.mainService = new hap.Service.Thermostat(this.name);

    this.mainService.getCharacteristic(hap.Characteristic.TargetHeatingCoolingState)
      .onGet(this.getMode.bind(this))
      .onSet(this.setMode.bind(this));

    this.mainService.getCharacteristic(hap.Characteristic.TargetTemperature)
      .onGet(this.getTargetTemperature.bind(this))
      .onSet(this.setTargetTemperature.bind(this));

    this.mainService.getCharacteristic(hap.Characteristic.HeatingThresholdTemperature)
      .onSet(this.setCurrentTemperature.bind(this));

    this.setCurrentTemperature(20);

    // create information service
    this.informationService = new hap.Service.AccessoryInformation()
      .setCharacteristic(hap.Characteristic.Manufacturer, 'Custom Manufacturer')
      .setCharacteristic(hap.Characteristic.Model, 'Custom Model');

    this.log.debug('Advanced thermostat finished initializing!');
  }

  /*
   * This method is optional to implement. It is called when HomeKit ask to identify the accessory.
   * Typical this only ever happens at the pairing process.
   */
  identify(): void {
    this.log.debug('Identify!');
  }

  /*
   * This method is called directly after creation of this instance.
   * It should return all services which should be added to the accessory.
   */
  getServices(): Service[] {
    return [
      this.informationService,
      this.mainService,
    ];
  }

  /**
   * Handle requests to get the current value of the "Current Heating Cooling State" characteristic
   */
  updateState() : void {
    const currentTemperature = this.getCurrentTemperature();
    let state = hap.Characteristic.CurrentHeatingCoolingState.OFF;
    if (currentTemperature !== null) {
      if (currentTemperature < this.targetTemperature) {
        if (this.mode === hap.Characteristic.TargetHeatingCoolingState.HEAT ||
            this.mode === hap.Characteristic.TargetHeatingCoolingState.AUTO) {
          state = hap.Characteristic.CurrentHeatingCoolingState.HEAT;
        }
      } else if (currentTemperature > this.targetTemperature) {
        if (this.mode === hap.Characteristic.TargetHeatingCoolingState.COOL ||
            this.mode === hap.Characteristic.TargetHeatingCoolingState.AUTO) {
          state = hap.Characteristic.CurrentHeatingCoolingState.COOL;
        }
      }
    }
    this.log.debug('Set state: ' + state);
    this.mainService.updateCharacteristic(hap.Characteristic.CurrentHeatingCoolingState, state);
  }

  /**
   * Handle requests to get the current value of the "Target Heating Cooling State" characteristic
   */
  getMode() : CharacteristicValue {
    this.log.debug('Get mode: ' + this.mode);
    return this.mode;
  }

  /**
   * Handle requests to set the "Target Heating Cooling State" characteristic
   */
  setMode(value: CharacteristicValue) {
    this.log.debug('Set mode: ' + value);
    this.mode = value;
    this.updateState();
  }

  /**
   * Handle requests to get the current value of the "Target Temperature" characteristic
   */
  getTargetTemperature() : CharacteristicValue {
    this.log.debug('Get target temperature: ' + this.targetTemperature);
    return this.targetTemperature;
  }

  /**
   * Handle requests to set the "Target Temperature" characteristic
   */
  setTargetTemperature(value: CharacteristicValue) {
    this.log.debug('Set target temperature: ' + value);
    this.targetTemperature = value;
    this.updateState();
  }

  getCurrentTemperature() : Nullable<CharacteristicValue> {
    const currentTemperature = this.mainService.getCharacteristic(hap.Characteristic.CurrentTemperature).value;
    this.log.debug('Get current temperature: ' + currentTemperature);
    return currentTemperature;
  }

  /**
   * Handle requests to set the "Target Temperature" characteristic
   */
  setCurrentTemperature(value: CharacteristicValue) {
    this.log.debug('Set current temperature: ' + value);
    this.mainService.updateCharacteristic(hap.Characteristic.CurrentTemperature, value);
    this.mainService.updateCharacteristic(hap.Characteristic.HeatingThresholdTemperature, value);

    this.updateState();
  }
}
