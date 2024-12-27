import type {
  Characteristic,
  CharacteristicValue,
  Logging,
  PlatformAccessory,
  Service,
  WithUUID,
} from 'homebridge';

import pkg from 'ber-tlv';

import platformAccessoryInformation from './platformAccessoryInformation.js';
import { TTLockAccessoryContext, TTLockHomeKeyPlatform } from './platform.js';
import { TTLockApi } from './api/ttlockApi.js';
import { Lock } from './types/index.js';

const { TlvFactory } = pkg;


export class TTLockHomeKitDevice {
  private readonly log: Logging;
  private readonly ttLockApi: TTLockApi | null = null;
  platformAccessory: PlatformAccessory<TTLockAccessoryContext>;
  private lockBusy = false;

  constructor(
    private readonly platform: TTLockHomeKeyPlatform,
    private readonly lock: Lock,
  ) {
    this.log = platform.log;
    this.ttLockApi = platform.ttLockApi;

    this.platformAccessory = this.initalizeAccessory();
    this.platformAccessory.on('identify', () => this.identify());

    this.checkServices();
  }

  private initalizeAccessory(): PlatformAccessory<TTLockAccessoryContext> {
    const uuid = this.platform.api.hap.uuid.generate(this.lock.id);
    const configuredPlatformAccessory = this.platform.configuredAccessories.get(uuid);
    let platformAccessory: PlatformAccessory<TTLockAccessoryContext>;

    if (!configuredPlatformAccessory) {
      this.log.debug(`Creating new Platform Accessory [${this.id}] [${uuid}]`);
      platformAccessory = new this.platform.api.platformAccessory(this.name, uuid);
      platformAccessory.context.id = this.id;
      this.platform.registerPlatformAccessory(platformAccessory);
    } else {
      this.log.debug(`Existing Platform Accessory found [${configuredPlatformAccessory.context.id}] ` +
        `[${configuredPlatformAccessory.UUID}]`);
      platformAccessory = configuredPlatformAccessory;
      this.updatePlatformAccessory(platformAccessory);
    }

    const accInfo = platformAccessoryInformation(this.platform.api.hap, this.platform.config.color)(platformAccessory, this);
    if (!accInfo) {
      this.log.error('Could not retrieve default AccessoryInformation');
    }

    return platformAccessory;
  }

  private updatePlatformAccessory(platformAccessory: PlatformAccessory<TTLockAccessoryContext>): void {
    this.correctPlatformAccessory(platformAccessory, 'displayName', this.name);
    this.correctPlatformAccessory(platformAccessory.context, 'id', this.id);
    this.platform.configuredAccessories.set(platformAccessory.UUID, platformAccessory);
    this.platform.api.updatePlatformAccessories([platformAccessory]);
  }

  private correctPlatformAccessory<T, K extends keyof T>(obj: T, key: K, expectedValue: T[K]): void {
    if (obj[key] !== expectedValue) {
      this.log.warn(`Correcting Platform Accessory ${String(key)} from: ${String(obj[key])} to: ${String(expectedValue)}`);
      obj[key] = expectedValue;
    }
  }

  get id(): string {
    return this.lock.id;
  }

  get name(): string {
    return this.lock.alias;
  }

  get manufacturer(): string {
    return 'TTLock';
  }

  get model(): string {
    return this.lock.model;
  }

  get serialNumber(): string {
    return this.lock.mac;
  }

  get firmwareRevision(): string {
    return this.lock.firmwareRevision;
  }

  private checkServices(): void {
    const services = [
      this.platform.api.hap.Service.LockManagement,
      this.platform.api.hap.Service.LockMechanism,
      this.platform.api.hap.Service.Battery,
      this.platform.api.hap.Service.AccessCode,
      this.platform.api.hap.Service.NFCAccess,
    ];

    services.forEach(service => {
      const checkedService: Service =
        this.platformAccessory.getService(service) ?? this.addService(service, this.name);
      if (checkedService.UUID !== this.platform.api.hap.Service.LockManagement.UUID) {
        this.checkCharacteristics(checkedService);
      }
      return checkedService;
    });
  }

  private addService(serviceConstructor: WithUUID<typeof this.platform.api.hap.Service>, name: string): Service {
    const serviceName = this.platform.getServiceName(serviceConstructor);
    this.log.debug(`Creating new ${serviceName} Service on ${name}`);
    return this.platformAccessory.addService(serviceConstructor, name, this.platformAccessory.UUID);
  }

  private checkCharacteristics(service: Service): void {
    const characteristicsMap = {
      LockMechanism: [
        {
          type: this.platform.api.hap.Characteristic.LockCurrentState,
          name: this.platform.getCharacteristicName(this.platform.api.hap.Characteristic.LockCurrentState),
        },
        {
          type: this.platform.api.hap.Characteristic.LockTargetState,
          name: this.platform.getCharacteristicName(this.platform.api.hap.Characteristic.LockTargetState),
        },
      ],
      Battery: [
        {
          type: this.platform.api.hap.Characteristic.BatteryLevel,
          name: this.platform.getCharacteristicName(this.platform.api.hap.Characteristic.BatteryLevel),
        },
        {
          type: this.platform.api.hap.Characteristic.StatusLowBattery,
          name: this.platform.getCharacteristicName(this.platform.api.hap.Characteristic.StatusLowBattery),
        },
      ],
      AccessCode: [
        {
          type: this.platform.api.hap.Characteristic.AccessCodeSupportedConfiguration,
          name: this.platform.getCharacteristicName(this.platform.api.hap.Characteristic.AccessCodeSupportedConfiguration),
        },
        {
          type: this.platform.api.hap.Characteristic.AccessCodeControlPoint,
          name: this.platform.getCharacteristicName(this.platform.api.hap.Characteristic.AccessCodeControlPoint),
        },
        {
          type: this.platform.api.hap.Characteristic.ConfigurationState,
          name: this.platform.getCharacteristicName(this.platform.api.hap.Characteristic.ConfigurationState),
        },
      ],
      NFCAccess: [
        {
          type: this.platform.api.hap.Characteristic.NFCAccessSupportedConfiguration,
          name: this.platform.getCharacteristicName(this.platform.api.hap.Characteristic.NFCAccessSupportedConfiguration),
        },
        {
          type: this.platform.api.hap.Characteristic.NFCAccessControlPoint,
          name: this.platform.getCharacteristicName(this.platform.api.hap.Characteristic.NFCAccessControlPoint),
        },
        {
          type: this.platform.api.hap.Characteristic.ConfigurationState,
          name: this.platform.getCharacteristicName(this.platform.api.hap.Characteristic.ConfigurationState),
        },
      ],
    };

    const serviceName = this.platform.getServiceName(service) as keyof typeof characteristicsMap;
    const characteristics = characteristicsMap[serviceName] || [];

    if (service.UUID === this.platform.api.hap.Service.AccessCode.UUID) {
      service.setCharacteristic(this.platform.api.hap.Characteristic.AccessCodeSupportedConfiguration, 'AQEBAwEGAwEJBAEQ');
    } else if (service.UUID === this.platform.api.hap.Service.NFCAccess.UUID) {
      service.setCharacteristic(this.platform.api.hap.Characteristic.NFCAccessSupportedConfiguration, 'AQEBAwEGAwEJBAEQ');
    }

    characteristics.forEach(({ type }) => {
      this.getOrAddCharacteristic(service, type);
    });
  }

  private getOrAddCharacteristic(
    service: Service,
    characteristicType: WithUUID<new () => Characteristic>,
  ): Characteristic {
    const characteristic: Characteristic = service.getCharacteristic(characteristicType) ??
      service.addCharacteristic(characteristicType);

    characteristic.onGet(this.handleOnGet.bind(this, service, characteristicType));

    if (characteristicType === this.platform.api.hap.Characteristic.LockTargetState) {
      characteristic.onSet(this.handleSetLockState.bind(this));
    } else if (characteristicType === this.platform.api.hap.Characteristic.AccessCodeControlPoint) {
      characteristic.onSet(this.handleSetAccessCodeControlPoint.bind(this));
    } else if (characteristicType === this.platform.api.hap.Characteristic.NFCAccessControlPoint) {
      characteristic.onSet(this.handleSetNFCAccessControlPoint.bind(this));
    }

    return characteristic;
  }

  private async handleOnGet(
    service: Service,
    characteristicType: WithUUID<new () => Characteristic>,
  ): Promise<CharacteristicValue> {
    if (characteristicType === this.platform.api.hap.Characteristic.LockCurrentState) {
      return this.handleGetLockState();
    } else if (characteristicType === this.platform.api.hap.Characteristic.BatteryLevel) {
      return this.handleBattery('batteryLevel');
    } else if (characteristicType === this.platform.api.hap.Characteristic.StatusLowBattery) {
      return this.handleBattery('lowBattery');
    } else if (characteristicType === this.platform.api.hap.Characteristic.AccessCodeControlPoint) {
      this.log.info('Queried Access Code Control Point');
      return '';
    } else if (characteristicType === this.platform.api.hap.Characteristic.NFCAccessControlPoint) {
      this.log.info('Queried NFC Access Control Point');
      return '';
    } else if (characteristicType === this.platform.api.hap.Characteristic.ConfigurationState) {
      if (service.UUID === this.platform.api.hap.Service.AccessCode.UUID) {
        this.log.info('Queried Access Code Configuration State');
      } else if (service.UUID === this.platform.api.hap.Service.NFCAccess.UUID) {
        this.log.info('Queried NFC Access Configuration State');
      }
      return this.lockBusy ? 1 : 0;
    }
    return '';
  }

  private async handleGetLockState(): Promise<CharacteristicValue> {
    try {
      if (!this.ttLockApi) {
        throw new Error('TTLock API not initialized');
      }
      const lock = await this.ttLockApi.getLockState(this.lock.id);
      if (lock.state === 0) {
        this.log.info(`Lock secured: ${this.name}`);
        return this.platform.api.hap.Characteristic.LockCurrentState.SECURED;
      } else {
        this.log.info(`Lock unsecured: ${this.name}`);
        return this.platform.api.hap.Characteristic.LockCurrentState.UNSECURED;
      }
    } catch (error) {
      this.log.error(`Failed to get current lock state for ${this.lock.id}:`, error);
      throw error;
    }
  }

  private async handleSetLockState(value: CharacteristicValue): Promise<void> {
    try {
      if (!this.ttLockApi) {
        throw new Error('TTLock API not initialized');
      }
      const targetState = value as number;
      if (targetState === this.platform.api.hap.Characteristic.LockTargetState.SECURED) {
        await this.ttLockApi.lock(this.lock.id);
        this.log.info(`Lock secured: ${this.name}`);
      } else {
        await this.ttLockApi.unlock(this.lock.id);
        this.log.info(`lock unsecured: ${this.name}`);
      }
    } catch (error) {
      this.log.error(`Failed to set lock state for ${this.lock.id}:`, error);
      throw error;
    }
  }

  private async handleBattery(type: 'lowBattery' | 'batteryLevel'): Promise<CharacteristicValue> {
    if (!this.ttLockApi) {
      throw new Error('TTLock API not initialized');
    }

    const lock = await this.ttLockApi.getBatteryLevel(this.lock.id);

    if (type === 'lowBattery') {
      if (lock.battery < 20) {
        this.log.warn(`Low battery level: ${this.name}`);
        return this.platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW;
      } else {
        return this.platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
      }
    } else {
      return lock.battery;
    }
  }

  private async handleSetAccessCodeControlPoint(value: CharacteristicValue): Promise<string> {
    if (!this.ttLockApi) {
      throw new Error('TTLock API not initialized');
    }
    try{
      this.lockBusy = true;
      this.log.debug(`Setting Access Code Control Point: ${value}`);
      const decTlv = TlvFactory.parse(Buffer.from(value.toString(), 'base64').toString('hex'));
      this.log.debug(`Decoded TLV: ${JSON.stringify(decTlv)}`);
      let responseTlv = '';
      let response = '';
      let identifier = '', accessCode = '', flags = '', status = '';

      switch (Number(decTlv[0].value.toString('hex'))) {
        case 1: {
          this.log.debug('Case 1: List Request');
          responseTlv = '010101';
          this.lock.passCodes.forEach((pc, index) => {
            identifier = TlvFactory.serialize(TlvFactory.primitiveTlv('01', String(pc.index).padStart(2, '0'))).toString('hex');
            accessCode = TlvFactory.serialize(TlvFactory.primitiveTlv('02', Buffer.from(pc.passcode).toString('hex'))).toString('hex');
            flags = TlvFactory.serialize(TlvFactory.primitiveTlv('03', '00')).toString('hex');
            status = TlvFactory.serialize(TlvFactory.primitiveTlv('04', '00')).toString('hex');
            this.log.debug(`Passcode: identifier=${identifier}, accessCode=${accessCode}, flags=${flags}, status=${status}`);
            responseTlv += TlvFactory.serialize(
              TlvFactory.primitiveTlv('03', identifier + accessCode + flags + status),
            ).toString('hex') + (index !== (this.lock.passCodes.length - 1) ? '0000' : '');
          });
          this.log.debug(`Response TLV: ${responseTlv}`);
          response = Buffer.from(responseTlv, 'hex').toString('base64');
          break;
        }
        case 2:
          this.log.debug('Case 2: Read Request');
          responseTlv = '010102';
          if (this.lock.passCodes.length > 0) {
            for (let index = 1; index < decTlv.length; ++index) {
              const element = decTlv[index];
              const readReq = TlvFactory.parse(element.value);
              if (readReq.length > 0) {
                const passcodeIndexHex = readReq[0].value.toString('hex');
                const passcodeIndex = parseInt(passcodeIndexHex, 16);
                const pc = this.lock.passCodes[passcodeIndex];
                if (pc) {
                  this.log.debug(`Read requested with passcode ${pc.passcode}`);
                  identifier = TlvFactory.serialize(TlvFactory.primitiveTlv('01', String(pc.index).padStart(2, '0'))).toString('hex');
                  accessCode = TlvFactory.serialize(
                    TlvFactory.primitiveTlv('02', Buffer.from(pc.passcode).toString('hex')),
                  ).toString('hex');
                  flags = TlvFactory.serialize(TlvFactory.primitiveTlv('03', '00')).toString('hex');
                  status = TlvFactory.serialize(TlvFactory.primitiveTlv('04', '00')).toString('hex');
                  this.log.debug(`Passcode read request: identifier=${identifier}, ` +
                  `accessCode=${accessCode}, flags=${flags}, status=${status}`);
                }
              }
              responseTlv += TlvFactory.serialize(
                TlvFactory.primitiveTlv('03', identifier + accessCode + flags + status),
              ).toString('hex') + (index !== (decTlv.length - 1) ? '0000' : '');
            }
          }
          this.log.debug(`Response TLV: ${responseTlv}`);
          response = Buffer.from(responseTlv, 'hex').toString('base64');
          break;
        case 3:
          this.log.debug('Case 3: Add or Change Request');
          responseTlv = '010103';
          for (let index = 1; index < decTlv.length; index++) {
            const addchangeReq = TlvFactory.parse(decTlv[index].value);
            if (addchangeReq.length > 0) {
              if (addchangeReq[0].tag === '01') {
                const newPassCodeHex = TlvFactory.parse(addchangeReq[1].value);
                const newPassCodeIndexHex = addchangeReq[0].value.toString('hex');
                const newPassCodeIndex = parseInt(newPassCodeIndexHex, 16);
                const existingPc = this.lock.passCodes[newPassCodeIndex];
                if (existingPc && newPassCodeHex.length > 0) {
                  const newPassCode = newPassCodeHex[0].value.toString();
                  this.log.info(`Changing passcode ${existingPc.passcode} to ${newPassCode} for lock with id ${this.lock.id}`);
                  await this.ttLockApi.changePasscode(this.lock.id, existingPc.id, newPassCode);
                  this.lock.passCodes = await this.ttLockApi.getPasscodes(this.lock.id);
                  const pc = this.lock.passCodes.find(p => p.id === existingPc.id);
                  if (pc) {
                    identifier = TlvFactory.serialize(TlvFactory.primitiveTlv('01', String(pc.index).padStart(2, '0'))).toString('hex');
                    accessCode = TlvFactory.serialize(
                      TlvFactory.primitiveTlv('02', Buffer.from(pc.passcode).toString('hex')),
                    ).toString('hex');
                    flags = TlvFactory.serialize(TlvFactory.primitiveTlv('03', '00')).toString('hex');
                    status = TlvFactory.serialize(TlvFactory.primitiveTlv('04', '00')).toString('hex');
                    this.log.debug(`Changed passcode: identifier=${identifier}, accessCode=${accessCode}, ` +
                        `flags=${flags}, status=${status}`);
                    responseTlv += TlvFactory.serialize(
                      TlvFactory.primitiveTlv('03', identifier + accessCode + flags + status),
                    ).toString('hex') + (index !== (decTlv.length - 1) ? '0000' : '');
                  }
                }
              } else if (addchangeReq[0].tag === '02') {
                const newPassCodeHex = addchangeReq[0];
                const newPassCode = newPassCodeHex.value.toString();
                this.log.info(`Adding new passcode ${newPassCode} to lock with id: ${this.lock.id}`);
                const newPc = await this.ttLockApi.addPasscode(this.lock.id, newPassCode);
                this.lock.passCodes = await this.ttLockApi.getPasscodes(this.lock.id);
                const pc = this.lock.passCodes.find(p => p.id === newPc.keyboardPwdId.toString());
                if (pc) {
                  identifier = TlvFactory.serialize(TlvFactory.primitiveTlv('01', String(pc.index).padStart(2, '0'))).toString('hex');
                  accessCode = TlvFactory.serialize(
                    TlvFactory.primitiveTlv('02', Buffer.from(pc.passcode).toString('hex')),
                  ).toString('hex');
                  flags = TlvFactory.serialize(TlvFactory.primitiveTlv('03', '00')).toString('hex');
                  status = TlvFactory.serialize(TlvFactory.primitiveTlv('04', '00')).toString('hex');
                  this.log.debug(`Added passcode: identifier=${identifier}, accessCode=${accessCode}, flags=${flags}, status=${status}`);
                  responseTlv += TlvFactory.serialize(
                    TlvFactory.primitiveTlv('03', identifier + accessCode + flags + status),
                  ).toString('hex') + (index !== (decTlv.length - 1) ? '0000' : '');
                }
              }
            }
          }
          this.log.debug(`Response TLV: ${responseTlv}`);
          response = Buffer.from(responseTlv, 'hex').toString('base64');
          break;
        case 5: {
          this.log.debug('Case 5: Delete Request');
          responseTlv = '010105';
          const deleteReq = TlvFactory.parse(decTlv[1].value);
          if (deleteReq.length > 0) {
            const deletePassCodeIndexHex = deleteReq[0].value.toString('hex');
            const deletePassCodeIndex = parseInt(deletePassCodeIndexHex, 16);
            const pc = this.lock.passCodes[deletePassCodeIndex];
            if (pc) {
              this.log.info(`Deleting passcode ${pc.passcode} for lock with id ${this.lock.id}`);
              await this.ttLockApi.deletePasscode(this.lock.id, pc.id);
              this.lock.passCodes = await this.ttLockApi.getPasscodes(this.lock.id);
              identifier = TlvFactory.serialize(TlvFactory.primitiveTlv('01', String(pc.index).padStart(2, '0'))).toString('hex');
              accessCode = TlvFactory.serialize(TlvFactory.primitiveTlv('02', Buffer.from(pc.passcode).toString('hex'))).toString('hex');
              flags = TlvFactory.serialize(TlvFactory.primitiveTlv('03', '00')).toString('hex');
              status = TlvFactory.serialize(TlvFactory.primitiveTlv('04', '00')).toString('hex');
              responseTlv += TlvFactory.serialize(TlvFactory.primitiveTlv('03', identifier + accessCode + flags + status)).toString('hex');
            }
          }
          this.log.debug(`Response TLV: ${responseTlv}`);
          response = Buffer.from(responseTlv, 'hex').toString('base64');
          break;
        }
      }
      return response;
    } finally {
      this.lockBusy = false;
    }
  }

  private async handleSetNFCAccessControlPoint(value: CharacteristicValue): Promise<void> {
    this.log.info(`Setting NFC Access Control Point: ${value}`);
  }

  public identify(): void {
    this.log.info(`Identifying lock: ${this.lock.alias}`);
  }
}