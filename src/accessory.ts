import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
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
  private readonly interval: number;
  private readonly cP: number;
  private readonly cI: number;
  private readonly cD: number;
  private readonly budgetThreshold: number;
  private readonly budgetFade: number;

  // Data Logging
  private readonly dataLogCsvDir: string;
  private readonly dataLogCsvBudget: boolean;
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
  private lastError?: number;
  private bias = 0;
  private budget = 0;
  private budgetDiscardedTotal = 0;

  constructor(log: Logging, config: AccessoryConfig, api: API) {
    this.log = log;

    // Configuration
    this.name = config.name;
    this.interval = config.interval;
    this.cP = config.pid.cP;
    this.cI = config.pid.cI;
    this.cD = config.pid.cD;
    this.budgetThreshold = config.modulation.budgetThreshold;
    this.budgetFade = config.modulation.budgetFade ?? 0.99;
    this.dataLogCsvDir = config.dataLog.csv.dir;
    this.dataLogCsvBudget = config.dataLog.csv.measurements.includes('budget');
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
    this.mode = this.thermostat.getCharacteristic(this.Mode);
    this.mode.setProps({ validValues: validModes });

    this.targetTemperature = this.thermostat.getCharacteristic(hap.Characteristic.TargetTemperature)
      .setProps({ minValue: 10, maxValue: 30});

    this.currentTemperature = this.thermostat.getCharacteristic(hap.Characteristic.CurrentTemperature);
    this.currentTemperature.setProps({ perms: this.currentTemperature.props.perms.concat(Perms.PAIRED_WRITE) })
      .onSet(t => log.debug('Current temperature: ' + (t as number).toFixed(1)));

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
    let persistedState: { mode?: CharacteristicValue; targetTemperature?: CharacteristicValue; accumulatedError?: number; bias?: number }
      | undefined;
    if (existsSync(this.persistPath)) {
      const rawFile = readFileSync(this.persistPath, 'utf8');
      persistedState = JSON.parse(rawFile);
    }
    this.mode.updateValue(persistedState?.mode ?? this.Mode.OFF);
    this.targetTemperature.updateValue(persistedState?.targetTemperature ?? 20);
    this.bias = persistedState?.bias ?? this.cI * (persistedState?.accumulatedError ?? 0);
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
        bias: this.bias,
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

  getModeName(state: CharacteristicValue | undefined | null): string {
    switch(state) {
      case this.Mode.OFF: return 'OFF';
      case this.Mode.HEAT: return 'HEAT';
      case this.Mode.COOL: return 'COOL';
      case this.Mode.AUTO: return 'AUTO';
      default: return 'unknown';
    }
  }

  getStateName(state: CharacteristicValue | undefined | null): string {
    switch(state) {
      case this.State.OFF: return 'OFF';
      case this.State.HEAT: return 'HEAT';
      case this.State.COOL: return 'COOL';
      default: return 'unknown';
    }
  }

  getActionString(action: { state: CharacteristicValue; duration: number }): string {
    return this.getStateName(action.state) + ': ' + this.formatMinutes(action.duration);
  }

  getAction(minutes: number): { state: CharacteristicValue; duration: number } {
    return {
      state: minutes >= 0 ? this.State.HEAT : this.State.COOL,
      duration: Math.abs(minutes),
    };
  }

  getMinutesActionString(minutes: number): string {
    return this.getActionString(this.getAction(minutes));
  }

  limitNumber(number: number, limit: number): number {
    const max = (this.mode.value === this.Mode.HEAT) || (this.mode.value === this.Mode.AUTO) ? limit : 0;
    const min = (this.mode.value === this.Mode.COOL) || (this.mode.value === this.Mode.AUTO) ? -limit : 0;
    return Math.max(Math.min(number, max), min);
  }

  limitBottom(number: number) {
    return this.mode.value === this.Mode.OFF ? 0 :
      this.mode.value === this.Mode.HEAT ? Math.max(number, 0) :
        this.mode.value === this.Mode.COOL ? Math.min(number, 0) :
          number;
  }

  formatMinutes(totalMinutes: number): string {
    const hours = Math.trunc(totalMinutes / 60);
    const remainingMinutes = Math.abs(totalMinutes - hours * 60);
    const minutes = Math.trunc(remainingMinutes);
    const seconds = Math.trunc(60 * (remainingMinutes - minutes));
    return (hours !== 0 ? hours + ':' +
           ('00' + minutes).slice(-2) + ':' : minutes + ':') +
           ('00' + seconds).slice(-2);
  }

  toDateString(date: Date): string {
    return date.getFullYear() + '-' + ('00' + (date.getMonth() + 1)).slice(-2) + '-' + ('00' + date.getDate()).slice(-2);
  }

  toTimeString(date: Date, includeOffset = true): string {
    let offsetString = '';
    if (includeOffset) {
      const offset = date.getTimezoneOffset();
      const offsetHours = Math.trunc(Math.abs(offset) / 60);
      const offsetMinutes = Math.abs(offset) - 60 * offsetHours;
      offsetString = ((offset === 0) ? 'Z' :
        ((offset <= 0 ? '+' : '-') + ('00' + offsetHours).slice(-2) + ':' + ('00' + offsetMinutes).slice(-2)));
    }
    return ('00' + date.getHours()).slice(-2) + ':' + ('00' + date.getMinutes()).slice(-2) + ':' + ('00' + date.getSeconds()).slice(-2) +
      offsetString;
  }

  toDateTimeString(date: Date, includeOffset = true): string {
    return this.toDateString(date) + 'T' + this.toTimeString(date, includeOffset);
  }

  logBasicData(now: Date, nextState: CharacteristicValue): void {
    if (this.state.value !== nextState) {
      this.log.info('Change state to [' + this.getStateName(nextState) + ']');
    }
    if (this.influxWriteApi && this.dataLogInfluxBasic) {
      const dataPoint = new Point('thermostat')
        .stringField('mode', this.getModeName(this.mode.value).toLowerCase())
        .floatField('target-temperature', this.targetTemperature.value)
        .floatField('current-temperature', this.currentTemperature.value)
        .stringField('state', this.getStateName(nextState).toLowerCase())
        .floatField('rate', nextState === this.State.HEAT ? 1 : (nextState === this.State.COOL ? -1 : 0))
        .booleanField('heating', nextState === this.State.HEAT)
        .booleanField('cooling', nextState === this.State.COOL)
        .timestamp(now);
      this.influxWriteApi.writePoint(dataPoint);
    }
  }

  logPidData(now: Date, pid: number, p: number, i: number, d: number): void {
    this.log.debug('PID: ' + pid.toFixed(2) + ' ' + '(P: ' + p.toFixed(3) + ', ' + 'I: ' + i.toFixed(3) + ', ' + 'D: ' + d.toFixed(3) + ') '
                   + '=> Budget: ' + this.getMinutesActionString(this.budget));
    if (this.influxWriteApi && this.dataLogInfluxPid) {
      const dataPoint = new Point('thermostat-pid')
        .floatField('pid', pid).floatField('p', p).floatField('i', i).floatField('d', d)
        .timestamp(now);
      this.influxWriteApi.writePoint(dataPoint);
    }
  }

  logBudgetData(now: Date, budget: number, inherited: number, added: number, used: number, discarded: number): void {
    if (this.dataLogCsvDir && this.dataLogCsvDir.trim()) {
      mkdirSync(this.dataLogCsvDir, {recursive: true});
      if (this.dataLogCsvBudget) {
        const fileName = `budget-${this.toDateString(now)}.csv`;
        const filePath = path.join(this.dataLogCsvDir, fileName);
        if (!existsSync(filePath)) {
          appendFileSync(filePath, 'date,localdate,budget,inherited,added,used,discarded\n');
        }
        appendFileSync(filePath,
          `${this.toDateTimeString(now)},${this.toDateTimeString(now, false)},${budget},${inherited},${added},${used},${discarded}\n`);
      }
    }
    if (this.influxWriteApi && this.dataLogInfluxBudget) {
      const dataPoint = new Point('thermostat-budget')
        .floatField('budget', budget)
        .floatField('budget-discarded', this.budgetDiscardedTotal)
        .timestamp(now);
      this.influxWriteApi.writePoint(dataPoint);
    }
  }

  runInterval() {
    // P
    const currentTemperature = (this.currentTemperature.value ?? this.targetTemperature.value) as number;
    const error = this.targetTemperature.value as number - currentTemperature;
    const proportionalFactor = this.cP * error;

    // I
    this.bias = this.limitNumber(this.bias + this.cI * error * this.interval, 1);
    const integralFactor = this.bias;

    // D
    const differentialError = (error - (this.lastError ?? error)) / this.interval;
    this.lastError = error;
    const differentialFactor = this.cD * differentialError;

    // PID Control equation
    const controlFactor = proportionalFactor + integralFactor + differentialFactor;

    // Compute budget
    const budgetUsed = this.state.value === this.State.HEAT ? this.interval : this.state.value === this.State.COOL ? -this.interval : 0;
    this.budget -= budgetUsed;
    const budgetInherited = this.budgetFade ** this.interval * this.budget;
    const budgetFaded = this.budget - budgetInherited;
    const bugdetUnlimited = controlFactor * this.interval + budgetInherited;
    this.budget = this.limitBottom(bugdetUnlimited);
    const budgetDiscarded = bugdetUnlimited - this.budget + budgetFaded;
    this.budgetDiscardedTotal = this.budgetFade ** this.interval * this.budgetDiscardedTotal + budgetDiscarded;
    const budgetAdded = this.budget - budgetInherited;

    // Determine action
    const nextState = this.budget >= this.budgetThreshold ? this.State.HEAT :
      this.budget <= -this.budgetThreshold ? this.State.COOL :
        this.state.value === this.State.HEAT && this.budget < this.interval ? this.State.OFF :
          this.state.value === this.State.COOL && this.budget > -this.interval ? this.State.OFF :
            this.state.value ?? this.State.OFF;

    // Log
    const now = new Date();
    this.logPidData(now, controlFactor, proportionalFactor, integralFactor, differentialFactor);
    this.logBudgetData(now, this.budget, budgetInherited, budgetAdded, budgetUsed, budgetDiscarded);
    this.logBasicData(now, nextState);
    this.influxWriteApi?.flush()?.catch(r => this.log.error('Error writing to InfluxDB: ' + r));

    // Execute
    this.state.updateValue(nextState);

    // Set trigger for temperature update 10s before next interval
    setTimeout(this.triggerCurrentTemperatureUpdate.bind(this), this.interval * 60000 - 10000);
  }

  triggerCurrentTemperatureUpdate(): void {
    this.trigger.getCharacteristic(hap.Characteristic.ProgrammableSwitchEvent)
      .sendEventNotification(hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
  }
}
