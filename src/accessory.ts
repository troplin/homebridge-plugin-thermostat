import { existsSync, readFileSync, writeFileSync } from 'fs';
import {
  AccessoryConfig,
  AccessoryPlugin,
  API,
  Characteristic,
  CharacteristicValue,
  HAP,
  Logging,
  Nullable,
  Perms,
  Service,
} from 'homebridge';
import path from 'path';

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

  // Internal
  private readonly log: Logging;
  private readonly persistPath: string;

  // Configuration
  private readonly name: string;
  private readonly interval: number;
  private readonly cP: number;
  private readonly cI: number;
  private readonly cD: number;

  // Services
  private readonly thermostat: Service;
  private readonly trigger: Service;
  private readonly information: Service;

  // Characteristics
  private readonly mode: Characteristic;
  private readonly targetTemperature: Characteristic;
  private readonly currentTemperature: Characteristic;

  // Internal state
  private lastError?: number;
  private accumulatedError = 50;

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

    // create information service
    this.information = new hap.Service.AccessoryInformation()
      .setCharacteristic(hap.Characteristic.Manufacturer, 'Custom Manufacturer')
      .setCharacteristic(hap.Characteristic.Model, 'Custom Model');

    // create thermostat service
    this.thermostat = new hap.Service.Thermostat(this.name);

    this.mode = this.thermostat.getCharacteristic(this.Mode);

    this.targetTemperature = this.thermostat.getCharacteristic(hap.Characteristic.TargetTemperature)
      .setProps({ minValue: 10, maxValue: 30});

    this.currentTemperature = this.thermostat.getCharacteristic(hap.Characteristic.CurrentTemperature);
    this.currentTemperature.setProps({ perms: this.currentTemperature.props.perms.concat(Perms.PAIRED_WRITE) });

    this.thermostat.getCharacteristic(hap.Characteristic.HeatingThresholdTemperature)
      .onSet(this.setCurrentTemperature.bind(this));

    // create trigger service
    this.trigger = new hap.Service.StatelessProgrammableSwitch();

    this.trigger.getCharacteristic(hap.Characteristic.ProgrammableSwitchEvent)
      .setProps({ validValues: [hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS] });

    // State
    this.loadState();

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
    let persistedState: { mode: CharacteristicValue; targetTemperature: CharacteristicValue; accumulatedError: number } | undefined;
    if (existsSync(this.persistPath)) {
      const rawFile = readFileSync(this.persistPath, 'utf8');
      persistedState = JSON.parse(rawFile);
    }
    this.mode.updateValue(persistedState?.mode ?? this.Mode.OFF);
    this.targetTemperature.updateValue(persistedState?.targetTemperature ?? 20);
    this.accumulatedError = persistedState?.accumulatedError ?? this.accumulatedError;
    if (persistedState !== undefined) {
      this.log.debug('State loaded from: ' + this.persistPath);
    }
  }

  private saveState(): void {
    writeFileSync(
      this.persistPath,
      JSON.stringify({
        mode: this.mode.value,
        targetTemperature: this.targetTemperature.value,
        integralError: this.accumulatedError,
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

  getCurrentTemperature() : Nullable<CharacteristicValue> {
    const currentTemperature = this.currentTemperature.value;
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
    const currentTemperature = (this.currentTemperature.value ?? this.targetTemperature.value) as number;
    const error = this.targetTemperature.value as number - currentTemperature;
    const proportionalFactor = this.cP * error;

    // I
    this.accumulatedError = Math.max(Math.min(this.accumulatedError + error * this.interval, 100), -100);
    const integralFactor = this.cI * this.accumulatedError;

    // D
    const differentialError = (error - (this.lastError ?? error)) / this.interval;
    this.lastError = error;
    const differentialFactor = this.cD * differentialError;

    // Control equation
    const controlFactor = proportionalFactor + integralFactor + differentialFactor;
    const maxControlFactor = (this.mode.value === this.Mode.HEAT) || (this.mode.value === this.Mode.AUTO) ? 1 : 0;
    const minControlFactor = (this.mode.value === this.Mode.COOL) || (this.mode.value === this.Mode.AUTO) ? -1 : 0;
    const controlFactorLimited = Math.max(Math.min(controlFactor, maxControlFactor), minControlFactor);
    this.log.debug('PID: ' + controlFactor.toFixed(2) +
      ' (P: ' + proportionalFactor.toFixed(3) +
      ', I: ' + integralFactor.toFixed(3) +
      ', D: ' + differentialFactor.toFixed(3) +
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
