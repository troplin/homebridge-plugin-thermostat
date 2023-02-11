import { existsSync, readFileSync, writeFileSync } from 'fs';
import {
  AccessoryConfig,
  AccessoryPlugin,
  API,
  CharacteristicValue,
  HAP,
  Logging,
  Nullable,
  Service,
} from 'homebridge';
import path, { join } from 'path';
import { compare } from 'semver';

/*
 * IMPORTANT NOTICE
 *
 * One thing you need to take care of is,
 * that you never ever ever import anything directly from the "homebridge" module (or the "hap-nodejs" module).
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

  // Types
  private readonly Mode = hap.Characteristic.TargetHeatingCoolingState;
  private readonly State = hap.Characteristic.CurrentHeatingCoolingState;

  private readonly log: Logging;

  private readonly thermostat: Service;
  private readonly trigger: Service;
  private readonly information: Service;

  // Configuration
  private readonly name: string;
  private readonly interval: number;
  private readonly cP: number;
  private readonly cI: number;
  private readonly cD: number;

  private readonly persistPath: string;

  // External state
  private mode: CharacteristicValue;
  private targetTemperature: CharacteristicValue;

  // Internal state
  private lastError?: number;
  private integralError = 0;

  constructor(log: Logging, config: AccessoryConfig, api: API) {
    this.log = log;

    // Configuration
    this.name = config.name;
    this.interval = config.interval;
    this.cP = config.pid.cP;
    this.cI = config.pid.cI;
    this.cD = config.pid.cD;

    const uuid = api.hap.uuid.generate(config.name);
    this.persistPath = path.join(api.user.persistPath(), `${config.accessory}.${uuid}.json`);

    // External state
    this.mode = this.Mode.OFF;
    this.targetTemperature = 20;
    this.loadState();

    // create information service
    this.information = new hap.Service.AccessoryInformation()
      .setCharacteristic(hap.Characteristic.Manufacturer, 'Custom Manufacturer')
      .setCharacteristic(hap.Characteristic.Model, 'Custom Model');

    // create thermostat service
    this.thermostat = new hap.Service.Thermostat(this.name);

    this.thermostat.getCharacteristic(this.Mode)
      .onGet(this.getMode.bind(this))
      .onSet(this.setMode.bind(this));

    this.thermostat.getCharacteristic(hap.Characteristic.TargetTemperature)
      .setProps({ minValue: 10, maxValue: 30})
      .onGet(this.getTargetTemperature.bind(this))
      .onSet(this.setTargetTemperature.bind(this));

    this.thermostat.getCharacteristic(hap.Characteristic.HeatingThresholdTemperature)
      .onSet(this.setCurrentTemperature.bind(this));

    // create trigger service
    this.trigger = new hap.Service.StatelessProgrammableSwitch();

    this.trigger.getCharacteristic(hap.Characteristic.ProgrammableSwitchEvent)
      .setProps({ validValues: [hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS] });

    // Initialize
    setTimeout(this.triggerCurrentTemperatureUpdate.bind(this), 10000);
    setTimeout(() => {
      setTimeout(this.runInterval.bind(this));
      setInterval(this.runInterval.bind(this), this.interval * 60000);
    }, 20000);

    api.on('shutdown', this.saveState.bind(this));

    this.log.debug('Advanced thermostat finished initializing!');
  }

  private loadState(): void {
    if (existsSync(this.persistPath)) {
      const rawFile = readFileSync(this.persistPath, 'utf8');
      const persistedState = JSON.parse(rawFile);
      this.mode = persistedState.mode ?? this.mode;
      this.targetTemperature = persistedState.targetTemperature ?? this.targetTemperature;
      this.log.debug('State loaded from: ' + this.persistPath);
    }
  }

  private saveState(): void {
    writeFileSync(
      this.persistPath,
      JSON.stringify({
        mode: this.mode,
        targetTemperature: this.targetTemperature,
      }),
    );
    this.log.debug('State saved to: ' + this.persistPath);
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
      this.information,
      this.thermostat,
      this.trigger,
    ];
  }

  /**
   * Handle requests to get the current value of the "Target Heating Cooling State" characteristic
   */
  getMode() : CharacteristicValue {
    return this.mode;
  }

  /**
   * Handle requests to set the "Target Heating Cooling State" characteristic
   */
  setMode(value: CharacteristicValue) {
    this.log.debug('Set mode: ' + value);
    this.mode = value;
  }

  /**
   * Handle requests to get the current value of the "Target Temperature" characteristic
   */
  getTargetTemperature() : CharacteristicValue {
    return this.targetTemperature;
  }

  /**
   * Handle requests to set the "Target Temperature" characteristic
   */
  setTargetTemperature(value: CharacteristicValue) {
    this.log.debug('Set target temperature: ' + value);
    this.targetTemperature = value;
  }

  getCurrentTemperature() : Nullable<CharacteristicValue> {
    const currentTemperature = this.thermostat.getCharacteristic(hap.Characteristic.CurrentTemperature).value;
    return currentTemperature;
  }

  /**
   * Handle requests to set the "Target Temperature" characteristic
   */
  setCurrentTemperature(value: CharacteristicValue) {
    this.log.debug('Current temperature: ' + (value as number).toFixed(1));
    this.thermostat.updateCharacteristic(hap.Characteristic.CurrentTemperature, value);
    this.thermostat.updateCharacteristic(hap.Characteristic.HeatingThresholdTemperature, value);
  }

  getStateName(state: CharacteristicValue): string {
    switch(state) {
      case this.State.OFF: return 'OFF';
      case this.State.HEAT: return 'HEAT';
      case this.State.COOL: return 'COOL';
      default: return 'unknown';
    }
  }

  getActionName(action: { state: CharacteristicValue; duration: number }): string {
    return this.getStateName(action.state) + ' for ' + action.duration + ' min';
  }

  runInterval() {
    // P
    const currentTemperature = this.getCurrentTemperature() ?? this.targetTemperature;
    const error = this.targetTemperature as number - (currentTemperature as number);
    const proportionalError = this.cP * error;

    // I
    this.integralError = Math.max(Math.min(this.integralError + this.cI * error * this.interval, 1), -1);

    // D
    const differentialError = this.cD * (error - (this.lastError ?? error)) / this.interval;
    this.lastError = error;

    // Control equation
    const controlFactor = proportionalError + this.integralError + differentialError;

    // Limit control factor according to mode
    const maxControlFactor = (this.mode === this.Mode.HEAT) || (this.mode === this.Mode.AUTO) ? 1 : 0;
    const minControlFactor = (this.mode === this.Mode.COOL) || (this.mode === this.Mode.AUTO) ? -1 : 0;
    const controlFactorLimited = Math.max(Math.min(controlFactor, maxControlFactor), minControlFactor);
    this.log.debug('PID: ' + controlFactor.toFixed(2) +
      ' (P: ' + proportionalError.toFixed(3) +
      ', I: ' + this.integralError.toFixed(3) +
      ', D: ' + differentialError.toFixed(3) +
      '), Limited: ' + controlFactorLimited.toFixed(2));

    // Determine action
    const state = this.thermostat.getCharacteristic(this.State);
    const actions = [ {
      state: controlFactorLimited >= 0 ? this.State.HEAT : this.State.COOL,
      duration: Math.round(Math.abs(controlFactorLimited) * this.interval),
    }, {
      state: this.State.OFF,
      duration: Math.round((1 - Math.abs(controlFactorLimited)) * this.interval),
    } ].filter(a => a.duration > 0)
      .sort((a1, a2) => a1.state === state.value ||
                        a2.state !== state.value && a1.state < a2.state ? -1 : 1);

    // Execute
    this.log.debug('Action: ' + actions.map(this.getActionName.bind(this)).join(', then ') + '.');
    actions.reduce((timeout, action) => {
      setTimeout(() => state.sendEventNotification(action.state), timeout * 60000);
      return timeout + action.duration;
    }, 0);

    // Set trigger for temperature update 10s before next interval
    setTimeout(this.triggerCurrentTemperatureUpdate.bind(this), this.interval * 60000 - 10000);
  }

  triggerCurrentTemperatureUpdate(): void {
    this.trigger.getCharacteristic(hap.Characteristic.ProgrammableSwitchEvent)
      .sendEventNotification(hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
  }
}
