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
  setLogger,
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
  private readonly heatingPower: number;
  private readonly coolingPower: number;
  private readonly cP: number;
  private readonly cI: number;
  private readonly cD: number;
  private readonly k: number;
  private readonly dt?: number;
  private readonly budgetThresholdJ: number;
  private readonly minimumUpdateIntervalS: number;

  // Data Logging
  private readonly influxDB?: InfluxDB;
  private readonly influxWriteApi?: WriteApi;
  private readonly dataLogInfluxBasic: boolean;
  private readonly dataLogInfluxPid: boolean;
  private readonly dataLogInfluxBudget: boolean;

  // Services
  private readonly thermostat: Service;
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
  private biasW = 0;
  private budgetJ = 0;

  constructor(log: Logging, config: AccessoryConfig, api: API) {
    this.log = log;

    // Configuration
    this.name = config.name;
    this.heatingPower = config.power?.heat ?? 0;
    this.coolingPower = config.power?.cool ?? 0;
    this.cP = config.pid.cP;
    this.cI = config.pid.cI;
    this.cD = config.pid.cD;
    this.k = config.pid.k ?? 0;
    this.dt = config.pid.dt;
    this.budgetThresholdJ = config.modulation.budgetThreshold;
    this.minimumUpdateIntervalS = config.dataLog?.minimumUpdateInterval ?? Infinity;
    setLogger({
      warn(message: string, err: Error) {
        log.warn(message + ' Error: ' + err.message);
      },
      error(message: string, err: Error) {
        log.error(message + ' Error: ' + err.message);
      },
    });
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

    // Modes
    const validModes = [this.Mode.OFF];
    if (this.heatingPower > 0) {
      validModes.push(this.Mode.HEAT);
    }
    if (this.coolingPower > 0) {
      validModes.push(this.Mode.COOL);
    }
    if (this.heatingPower > 0 && this.coolingPower > 0) {
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

    // States
    const validStates = [this.State.OFF];
    if (this.heatingPower > 0) {
      validStates.push(this.Mode.HEAT);
    }
    if (this.coolingPower > 0) {
      validStates.push(this.Mode.COOL);
    }
    this.state = this.thermostat.getCharacteristic(this.State)
      .setProps({ validValues: validStates });

    // State
    this.loadState();

    // Set update timer
    this.scheduledUpdate = setTimeout(this.update.bind(this, 'Startup complete'), 60000);

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
    this.biasW = persistedState?.biasW ?? 0;
    this.budgetJ = persistedState?.budgetJ ?? 0;
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
      biasW: this.biasW,
      budgetJ: this.budgetJ,
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

  private getRate(state: CharacteristicValue | undefined | null): number {
    return state === this.State.HEAT ? 1 : (state === this.State.COOL ? -1 : 0);
  }

  private getPower(state: CharacteristicValue | undefined | null): number {
    return state === this.State.HEAT ? this.heatingPower : (state === this.State.COOL ? -this.coolingPower : 0);
  }

  private limitPower(power: number): number {
    const max = (this.mode.value === this.Mode.HEAT) || (this.mode.value === this.Mode.AUTO) ? this.heatingPower : 0;
    const min = (this.mode.value === this.Mode.COOL) || (this.mode.value === this.Mode.AUTO) ? -this.coolingPower : 0;
    return Math.max(Math.min(power, max), min);
  }

  private formatSeconds(totalSeconds: number): string {
    if (!isFinite(totalSeconds)) {
      return totalSeconds.toString();
    }
    const hours = Math.trunc(totalSeconds / 3600);
    let seconds = Math.abs(totalSeconds - hours * 3600);
    const minutes = Math.trunc(seconds / 60);
    seconds = Math.trunc(seconds - 60 * minutes);
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

  private logBasicData(oldState: CharacteristicValue, durationS: number, logMessage?: string): void {
    if (oldState !== this.state.value || logMessage) {
      const suffix = 'for an ' + (isFinite(durationS) ? `expected duration of ${this.formatSeconds(durationS)}.` : 'unknown duration.');
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
        .floatField('power', this.getPower(this.state.value))
        .timestamp(this.updated);
      this.influxWriteApi.writePoint(dataPoint);
    }
  }

  private logPidData(elapsedS: number, budgetAddedDJ: number, durationS: number, compensationFactor: number): void {
    const p = this.cP * (this.error ?? 0) * compensationFactor;
    const i = this.biasW;
    const d = elapsedS > 0 ? budgetAddedDJ / elapsedS : 0;
    const pid = p + i + d;
    this.log.debug('PID: ' + pid.toFixed(2) + ' ' + '(P: ' + p.toFixed(3) + ', ' + 'I: ' + i.toFixed(3) + ', ' + 'D: ' + d.toFixed(3) + ') '
                   + '=> Budget: ' + this.budgetJ + ' J '
                   + '=> Duration: ' + this.formatSeconds(durationS));
    if (this.influxWriteApi && this.dataLogInfluxPid) {
      const dataPoint = new Point('thermostat-pid')
        // In Watts:
        .floatField('i-w', i)
        .floatField('p-w', p)
        .floatField('comp', compensationFactor)
        .timestamp(this.updated);
      this.influxWriteApi.writePoint(dataPoint);
    }
  }

  private logBudgetData(): void {
    if (this.influxWriteApi && this.dataLogInfluxBudget) {
      const dataPoint = new Point('thermostat-budget')
        .floatField('budget-j', this.budgetJ)
        .timestamp(this.updated);
      this.influxWriteApi.writePoint(dataPoint);
    }
  }

  private logData(oldState: CharacteristicValue, elapsedS: number, budgetAddedDJ: number, durationS: number, compensationFactor: number,
    logMessage?: string): void {
    this.logBudgetData();
    this.logBasicData(oldState, durationS, logMessage);
    this.logPidData(elapsedS, budgetAddedDJ, durationS, compensationFactor);
  }

  private computeDuration(compensationFactor: number): number {
    const epsilon = 0.00000001;
    const power = this.getPower(this.state.value);
    let limit = [0];
    if (this.state.value === this.State.OFF) {
      switch (this.mode.value) {
        case this.Mode.OFF: return Infinity;
        case this.Mode.HEAT: limit = [this.budgetThresholdJ]; break;
        case this.Mode.COOL: limit = [-this.budgetThresholdJ]; break;
        case this.Mode.AUTO: limit = [-this.budgetThresholdJ, this.budgetThresholdJ];
      }
    }
    // Solve quadratic equation
    // b(t) = l
    // ingetral_t(cI * e * t + I0) + cP * e * t - r * t + b0 = l
    // 0.5 * cI * e * t^2 + I0 * t + cP * e * t - r * t + b0 = l
    // 0.5*cI*e * t^2  +  (I0 + cP*e - r) * t  +  b0 - l = 0
    const a = 0.5 * (this.cI * compensationFactor) * (this.error ?? 0);
    const b = this.biasW + this.cP * (this.error ?? 0) - power;
    const c = limit.map(l => this.budgetJ - l);
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

  private canHeat(): boolean {
    return this.mode.value === this.Mode.HEAT || this.mode.value === this.Mode.AUTO;
  }

  private canCool(): boolean {
    return this.mode.value === this.Mode.COOL || this.mode.value === this.Mode.AUTO;
  }

  private getCompensationFactor(error: number, biasW: number): number {
    const headroom = error >= 0 ? (this.heatingPower - biasW) : (biasW - this.coolingPower);
    const dt = this.dt ?? Math.abs(error);
    const factor = 1 / (1 + this.k * dt /headroom);
    return Number.isNaN(factor) ? 0 : factor;
  }

  private update(logMessage?: string, shutdown = false) {
    clearTimeout(this.scheduledUpdate);

    // Temperatures and error
    const targetTemperature = this.targetTemperature.value as number;
    const currentTemperature = (this.currentTemperature.value ?? this.targetTemperature.value) as number;
    const error = targetTemperature - currentTemperature;

    // Time
    const now = new Date();
    const elapsedSeconds = this.updated ? (now.getTime() - this.updated.getTime()) / 1000 : undefined;

    // Bias
    const oldCompensationFactor = this.getCompensationFactor(this.error ?? 0, this.biasW);
    const newBiasWUnlimited = this.biasW + this.cI * oldCompensationFactor * (this.error ?? 0) * (elapsedSeconds ?? 0);
    const newBiasW = this.limitPower(newBiasWUnlimited);
    const newCompensationFactor = this.getCompensationFactor(error, newBiasW);
    const avgCompensationFactor = 0.5 * (oldCompensationFactor + newCompensationFactor);

    // Compensation for limited heating cooling capacity:
    // Only the duration where the bias is not over/under limits is counted for P and I calculation.
    let elapsedSecondsUnLimited = elapsedSeconds ?? 0;
    if (newBiasW !== newBiasWUnlimited) {
      // CI * compensation * error is guaranteed != 0
      elapsedSecondsUnLimited = (newBiasW - this.biasW) / (this.cI * oldCompensationFactor * (this.error ?? 0));
    }

    // Update budget
    this.budgetJ -= (elapsedSeconds ?? 0) * this.getPower(this.state.value); // Used
    const budgetAddedPJ = elapsedSecondsUnLimited * this.cP * avgCompensationFactor * (this.error ?? 0);
    const budgetAddedIJ = elapsedSecondsUnLimited * (this.biasW + newBiasW) / 2;
    const budgetAddedDJ = (this.error !== undefined) ? this.cD * (error - this.error) : 0;
    this.budgetJ += budgetAddedPJ + budgetAddedIJ + budgetAddedDJ;

    // Determine next state
    const oldState = this.state.value ?? this.State.OFF;
    const nextState = shutdown ? this.State.OFF :
      (this.canHeat() && (this.budgetJ >= this.budgetThresholdJ)) ? this.State.HEAT :
        (this.canCool() && (this.budgetJ <= -this.budgetThresholdJ)) ? this.State.COOL :
          oldState === this.State.HEAT && (this.budgetJ <= 0 || !this.canHeat()) ? this.State.OFF :
            oldState === this.State.COOL && (this.budgetJ >= 0 || !this.canCool()) ? this.State.OFF :
              oldState;

    // Update state
    this.state.updateValue(nextState);
    this.updated = now;
    this.error = error;
    this.biasW = newBiasW;

    // Log
    const durationS = this.computeDuration(newCompensationFactor);
    this.logData(oldState, elapsedSeconds ?? 0, budgetAddedDJ, durationS, newCompensationFactor, logMessage);

    // Set next iteration
    if (!shutdown) {
      const durationMs = Math.min(Math.min(durationS, this.minimumUpdateIntervalS) * 1000, 2147483647); // Limit to max possible value
      this.scheduledUpdate = setTimeout(this.update.bind(this), durationMs);
    }
  }

  private updateMode(newMode: CharacteristicValue) {
    if (this.mode.value !== newMode) {
      setImmediate(this.update.bind(this, 'Mode changed ' + this.formatValueChange(this.mode.value, newMode, this.getModeName.bind(this))));
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
  biasW?: number;
  budgetJ?: number;
};
