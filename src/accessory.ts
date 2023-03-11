import { existsSync, readFileSync, writeFileSync } from 'fs';
import {
  AccessoryConfig,
  AccessoryPlugin,
  API,
  Characteristic,
  CharacteristicValue,
  HAP,
  Logging,
  Perms,
  Service,
} from 'homebridge';
import path from 'path';
import {
  InfluxDB,
  Point,
  WriteApi,
} from '@influxdata/influxdb-client';

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
  private readonly cP: number;
  private readonly cI: number;
  private readonly cD: number;
  private readonly budgetThreshold: number;
  private readonly minimumUpdateInterval: number;

  // Data Logging
  private readonly influxDB?: InfluxDB;
  private readonly influxWriteApi?: WriteApi;
  private readonly dataLogInfluxBasic: boolean;
  private readonly dataLogInfluxPid: boolean;
  private readonly dataLogInfluxBudget: boolean;

  // Services
  private readonly thermostat: Service;
  private readonly trigger: Service;
  private readonly information: Service;

  // Characteristics
  private readonly mode: Characteristic;
  private readonly targetTemperature: Characteristic;
  private readonly currentTemperature: Characteristic;
  private readonly state: Characteristic;

  // Internal state
  private scheduledUpdate: NodeJS.Timeout;
  private updated?: Date;
  private error?: number;
  private bias = 0;
  private budget = 0;

  constructor(log: Logging, config: AccessoryConfig, api: API) {
    this.log = log;

    // Configuration
    this.name = config.name;
    this.cP = config.pid.cP;
    this.cI = config.pid.cI;
    this.cD = config.pid.cD;
    this.budgetThreshold = config.modulation.budgetThreshold;
    this.minimumUpdateInterval = config.dataLog?.minimumUpdateInterval ?? Infinity;
    this.influxDB = config.dataLog.influx.host ? new InfluxDB({ url: config.dataLog.influx.host, token: config.dataLog.influx.token})
      : undefined;
    this.influxWriteApi = this.influxDB?.getWriteApi(config.dataLog.influx.org, config.dataLog.influx.bucket, 's')
      .useDefaultTags({ accessory: config.name,
        ...Object.fromEntries(config.dataLog.influx.tags.map((t: { name: string; value: string }) => [t.name, t.value]))});
    this.dataLogInfluxBasic = config.dataLog.influx.measurements.includes('thermostat');
    this.dataLogInfluxPid = config.dataLog.influx.measurements.includes('thermostat-pid');
    this.dataLogInfluxBudget = config.dataLog.influx.measurements.includes('thermostat-budget');

    const uuid = api.hap.uuid.generate(config.name);
    this.persistPath = path.join(api.user.persistPath(), `${config.accessory}.${uuid}.json`);

    // create information service
    this.information = new hap.Service.AccessoryInformation()
      .setCharacteristic(hap.Characteristic.Manufacturer, 'troplin Software')
      .setCharacteristic(hap.Characteristic.Model, 'Advanced Thermostat');

    // create thermostat service
    this.thermostat = new hap.Service.Thermostat(this.name);

    const validModes = [this.Mode.OFF].concat(config.modes.map((m: string) => m === 'heat' ? this.Mode.HEAT : this.Mode.COOL));
    if (config.modes.includes('heat') && config.modes.includes('cool')) {
      validModes.push(this.Mode.AUTO);
    }
    this.mode = this.thermostat.getCharacteristic(this.Mode)
      .setProps({ validValues: validModes })
      .onSet(this.updateMode.bind(this));

    this.targetTemperature = this.thermostat.getCharacteristic(hap.Characteristic.TargetTemperature)
      .setProps({ minValue: 10, maxValue: 30})
      .onSet(this.updateTargetTemperature.bind(this));

    this.currentTemperature = this.thermostat.getCharacteristic(hap.Characteristic.CurrentTemperature);
    this.currentTemperature
      .setProps({ perms: this.currentTemperature.props.perms.concat(Perms.PAIRED_WRITE) })
      .onSet(this.updateCurrentTemperature.bind(this));

    this.state = this.thermostat.getCharacteristic(this.State);
    this.state.setProps({
      validValues: [this.State.OFF].concat(config.modes.map((m: string) => m === 'heat' ? this.State.HEAT : this.State.COOL)),
    });

    // create trigger service
    this.trigger = new hap.Service.StatelessProgrammableSwitch();

    this.trigger.getCharacteristic(hap.Characteristic.ProgrammableSwitchEvent)
      .setProps({ validValues: [hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS] });

    // State
    this.loadState();

    // Set update timers
    setTimeout(() => {
      setTimeout(this.triggerCurrentTemperatureUpdate.bind(this));
      setInterval(this.triggerCurrentTemperatureUpdate.bind(this), 60000);
    }, 10000);
    this.scheduledUpdate = setTimeout(this.update.bind(this, 'Startup complete'), 20000);

    api.on('shutdown', this.shutdown.bind(this));

    this.log.debug('Advanced thermostat finished initializing!');
  }

  private loadState(): void {
    let persistedState: AdvancedThermostatPersistedState | undefined;
    if (existsSync(this.persistPath)) {
      const rawFile = readFileSync(this.persistPath, 'utf8');
      persistedState = JSON.parse(rawFile);
    }
    this.mode.updateValue(persistedState?.mode ?? this.Mode.OFF);
    this.state.updateValue(persistedState?.state ?? this.State.OFF);
    this.targetTemperature.updateValue(persistedState?.targetTemperature ?? 20);
    this.currentTemperature.updateValue(persistedState?.temperature ?? persistedState?.targetTemperature ?? 20);
    this.updated = persistedState?.updated ? new Date(persistedState?.updated) : undefined;
    this.error = persistedState?.error;
    this.bias = persistedState?.bias ?? 0;
    this.budget = persistedState?.budget ?? 0;
    if (persistedState !== undefined) {
      this.log.debug('State loaded from: ' + this.persistPath);
    }
  }

  private saveState(): void {
    const persistedState: AdvancedThermostatPersistedState = {
      mode: this.mode.value ?? undefined,
      state: this.state.value ?? undefined,
      targetTemperature: this.targetTemperature.value ?? undefined,
      temperature: this.currentTemperature.value ?? undefined,
      updated: this.updated?.toISOString(),
      error: this.error,
      bias: this.bias,
      budget: this.budget,
    };
    writeFileSync(this.persistPath, JSON.stringify(persistedState));
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

  private getModeName(state: CharacteristicValue | undefined | null): string {
    switch(state) {
      case this.Mode.OFF: return 'OFF';
      case this.Mode.HEAT: return 'HEAT';
      case this.Mode.COOL: return 'COOL';
      case this.Mode.AUTO: return 'AUTO';
      default: return 'unknown';
    }
  }

  private getStateName(state: CharacteristicValue | undefined | null): string {
    switch(state) {
      case this.State.OFF: return 'OFF';
      case this.State.HEAT: return 'HEAT';
      case this.State.COOL: return 'COOL';
      default: return 'unknown';
    }
  }

  private getActionString(action: { state: CharacteristicValue; duration: number }): string {
    return this.getStateName(action.state) + ': ' + this.formatMinutes(action.duration);
  }

  private getAction(minutes: number): { state: CharacteristicValue; duration: number } {
    return {
      state: minutes >= 0 ? this.State.HEAT : this.State.COOL,
      duration: Math.abs(minutes),
    };
  }

  private getMinutesActionString(minutes: number): string {
    return this.getActionString(this.getAction(minutes));
  }

  private getRate(state: CharacteristicValue | undefined | null): number {
    return state === this.State.HEAT ? 1 : (state === this.State.COOL ? -1 : 0);
  }

  private limitNumber(number: number, limit: number): number {
    const max = (this.mode.value === this.Mode.HEAT) || (this.mode.value === this.Mode.AUTO) ? limit : 0;
    const min = (this.mode.value === this.Mode.COOL) || (this.mode.value === this.Mode.AUTO) ? -limit : 0;
    return Math.max(Math.min(number, max), min);
  }

  private limitBottom(number: number, limit = 0) {
    return this.mode.value === this.Mode.OFF ? limit :
      this.mode.value === this.Mode.HEAT ? Math.max(number, limit) :
        this.mode.value === this.Mode.COOL ? Math.min(number, limit) :
          number;
  }

  private formatMinutes(totalMinutes: number): string {
    if (!isFinite(totalMinutes)) {
      return totalMinutes.toString();
    }
    const hours = Math.trunc(totalMinutes / 60);
    const remainingMinutes = Math.abs(totalMinutes - hours * 60);
    const minutes = Math.trunc(remainingMinutes);
    const seconds = Math.trunc(60 * (remainingMinutes - minutes));
    return (hours !== 0 ? hours + ':' +
           ('00' + minutes).slice(-2) + ':' : minutes + ':') +
           ('00' + seconds).slice(-2);
  }

  private formatTemperature(temperature: CharacteristicValue | null): string {
    return temperature + ' °C';
  }

  private formatValueChange(oldValue: CharacteristicValue | null, newValue: CharacteristicValue | null,
    format: (value: CharacteristicValue | null) => string): string {
    return `from ${format(oldValue)} to [${format(newValue)}]`;
  }

  private logBasicData(oldState: CharacteristicValue, duration: number, logMessage?: string): void {
    if (oldState !== this.state.value || logMessage) {
      const suffix = 'for an ' + (isFinite(duration) ? `expected duration of ${this.formatMinutes(duration)}.` : 'unknown duration.');
      if (oldState !== this.state.value && logMessage) {
        this.log.info(`${logMessage}, change state ${this.formatValueChange(oldState, this.state.value, this.getStateName.bind(this))} `
        + suffix);
      } else if (logMessage) {
        this.log.info(`${logMessage}, continue with ${this.getStateName(this.state.value)} ` + suffix);
      } else {
        this.log.info(`Change state ${this.formatValueChange(oldState, this.state.value, this.getStateName.bind(this))} ` + suffix);
      }
    }
    if (this.influxWriteApi && this.dataLogInfluxBasic) {
      const dataPoint = new Point('thermostat')
        .stringField('mode', this.getModeName(this.mode.value).toLowerCase())
        .floatField('target-temperature', this.targetTemperature.value)
        .floatField('current-temperature', this.currentTemperature.value)
        .stringField('state', this.getStateName(this.state.value).toLowerCase())
        .floatField('rate', this.getRate(this.state.value))
        .booleanField('heating', this.state.value === this.State.HEAT)
        .booleanField('cooling', this.state.value === this.State.COOL)
        .timestamp(this.updated);
      this.influxWriteApi.writePoint(dataPoint);
    }
  }

  private logPidData(elapsed: number, budgetAddedD: number, duration: number): void {
    const p = this.cP * (this.error ?? 0);
    const i = this.bias;
    const d = elapsed > 0 ? budgetAddedD / elapsed : 0;
    const pid = p + i + d;
    this.log.debug('PID: ' + pid.toFixed(2) + ' ' + '(P: ' + p.toFixed(3) + ', ' + 'I: ' + i.toFixed(3) + ', ' + 'D: ' + d.toFixed(3) + ') '
                   + '=> Budget: ' + this.getMinutesActionString(this.budget) + ' '
                   + '=> Duration: ' + this.formatMinutes(duration));
    if (this.influxWriteApi && this.dataLogInfluxPid) {
      const dataPoint = new Point('thermostat-pid')
        .floatField('pid', pid).floatField('pi', p + i).floatField('p', p).floatField('i', i).floatField('d', d)
        .timestamp(this.updated);
      this.influxWriteApi.writePoint(dataPoint);
    }
  }

  private logBudgetData(): void {
    if (this.influxWriteApi && this.dataLogInfluxBudget) {
      const dataPoint = new Point('thermostat-budget')
        .floatField('budget', this.budget)
        .timestamp(this.updated);
      this.influxWriteApi.writePoint(dataPoint);
    }
  }

  private logData(oldState: CharacteristicValue, elapsed: number, budgetAddedD: number, duration: number, logMessage?: string): void {
    this.logBudgetData();
    this.logBasicData(oldState, duration, logMessage);
    this.logPidData(elapsed, budgetAddedD, duration);
  }

  private computeDuration(): number {
    const epsilon = 0.00000001;
    const rate = this.getRate(this.state.value);
    let limit = [0];
    if (this.state.value === this.State.OFF) {
      switch (this.mode.value) {
        case this.Mode.OFF: return Infinity;
        case this.Mode.HEAT: limit = [this.budgetThreshold]; break;
        case this.Mode.COOL: limit = [-this.budgetThreshold]; break;
        case this.Mode.AUTO: limit = [-this.budgetThreshold, this.budgetThreshold];
      }
    }
    // Solve quadratic equation
    // b(t) = l
    // ingetral_t(cI * e * t + I0) + cP * e * t - r * t + b0 = l
    // 0.5 * cI * e * t^2 + I0 * t + cP * e * t - r * t + b0 = l
    // 0.5*cI*e * t^2  +  (I0 + cP*e - r) * t  +  b0 - l = 0
    const a = 0.5 * this.cI * (this.error ?? 0);
    const b = this.bias + this.cP * (this.error ?? 0) - rate;
    const c = limit.map(l => this.budget - l);
    if (Math.abs(a) > epsilon) {
      // t1,2 = (-b +/- sqrt(b^2 - 4ac)) / 2a
      const underSqrt = c.map(c => b**2 - 4 * a * c);
      const sqrt = underSqrt.filter(us => us >= 0).map(us => Math.sqrt(us));
      const t = sqrt.flatMap(sq => [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]);
      //this.log.debug(`Quadratic: a = ${a}, b = ${b}, c = ${c}, underSqrt = ${underSqrt}, t = ${t}.`);
      return Math.min(...t.filter(t => t > 0), Infinity);
    } else if (Math.abs(b) > epsilon) {
      // Linear special case
      const t = c.map(c => -c / b);
      //this.log.debug(`Linear: a = ${a}, b = ${b}, c = ${c}, t = ${t}.`);
      return Math.min(...t.filter(t => t > 0), Infinity);
    } else {
      //this.log.debug(`Infinite: a = ${a}, b = ${b}, c = ${c}`);
      return Infinity;
    }
  }

  private update(logMessage?: string, shutdown = false) {
    clearTimeout(this.scheduledUpdate);

    // Temperatures and error
    const targetTemperature = this.targetTemperature.value as number;
    const currentTemperature = (this.currentTemperature.value ?? this.targetTemperature.value) as number;
    const error = targetTemperature - currentTemperature;

    // Time
    const now = new Date();
    const elapsed = this.updated ? (now.getTime() - this.updated.getTime()) / 60000 : undefined;

    // Bias
    const newBias = this.limitNumber(this.bias + this.cI * (this.error ?? 0) * (elapsed ?? 0), 1);

    // Update budget
    const budgetElapsed = elapsed ?? 0;
    this.budget -= budgetElapsed * this.getRate(this.state.value); // Used
    const budgetLimitP = -this.limitBottom(this.budget); // Limit it s.t. it doesn't drive the budget more negative.
    const budgetAddedP = this.limitBottom(budgetElapsed * this.cP * (this.error ?? 0), budgetLimitP);
    const budgetAddedI = budgetElapsed * (this.bias + newBias) / 2; // Can never be negative (bias is limited)
    const budgetAddedD = (this.error !== undefined) ? this.cD * (error - this.error) : 0; // Allow budget to become negative
    this.budget += budgetAddedP + budgetAddedI + budgetAddedD;

    // Determine next state
    const oldState = this.state.value ?? this.State.OFF;
    const nextState = shutdown ? this.State.OFF :
      this.budget >= this.budgetThreshold ? this.State.HEAT :
        this.budget <= -this.budgetThreshold ? this.State.COOL :
          oldState === this.State.HEAT && this.budget <= 0 ? this.State.OFF :
            oldState === this.State.COOL && this.budget >= 0 ? this.State.OFF :
              oldState;

    // Update state
    this.state.updateValue(nextState);
    this.updated = now;
    this.error = error;
    this.bias = newBias;

    // Log
    const duration = this.computeDuration();
    this.logData(oldState, elapsed ?? 0, budgetAddedD, duration, logMessage);

    // Set next iteration
    if (!shutdown) {
      const durationMs = Math.min(Math.min(duration, this.minimumUpdateInterval) * 60000, 2147483647); // Limit to max possible value
      this.scheduledUpdate = setTimeout(this.update.bind(this), durationMs);
    }
  }

  private triggerCurrentTemperatureUpdate(): void {
    this.trigger.getCharacteristic(hap.Characteristic.ProgrammableSwitchEvent)
      .sendEventNotification(hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
  }

  private updateMode(newMode: CharacteristicValue) {
    if (this.mode.value !== newMode) {
      setImmediate(this.update.bind(this, 'Mode changed' + this.formatValueChange(this.mode.value, newMode, this.getModeName.bind(this))));
    } else {
      this.log.debug('Mode: ' + this.getModeName(newMode));
    }
  }

  private updateCurrentTemperature(newTemperature: CharacteristicValue) {
    if (this.currentTemperature.value !== newTemperature) {
      setImmediate(this.update.bind(this, 'Current temperature changed ' + this.formatValueChange(this.currentTemperature.value,
        newTemperature, this.formatTemperature.bind(this))));
    } else {
      this.log.debug('Current temperature: ' + this.formatTemperature(newTemperature));
    }
  }

  private updateTargetTemperature(newTemperature: CharacteristicValue) {
    if (this.targetTemperature.value !== newTemperature) {
      setImmediate(this.update.bind(this, 'Target temperature changed ' + this.formatValueChange(this.targetTemperature.value,
        newTemperature, this.formatTemperature.bind(this))));
    } else {
      this.log.debug('Target temperature: ' + this.formatTemperature(newTemperature));
    }
  }

  private shutdown(): void {
    //this.update(true);
    clearTimeout(this.scheduledUpdate);
    this.saveState();
  }
}

type AdvancedThermostatPersistedState = {
  updated?: string;
  mode?: CharacteristicValue;
  state?: CharacteristicValue;
  targetTemperature?: CharacteristicValue;
  temperature?: CharacteristicValue;
  error?: number;
  bias?: number;
  budget?: number;
};
