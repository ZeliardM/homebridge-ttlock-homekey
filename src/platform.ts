import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, WithUUID } from 'homebridge';

import { TTLockHomeKitDevice } from './homekitDevice.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { lookup, lookupCharacteristicNameByUUID, isObjectLike } from './utils.js';
import { TTLockApi } from './api/ttlockApi.js';
import { BatteryLevel, Lock, LockDetails, LockState, NfcCardList, PasscodeList } from './types';

export type TTLockAccessoryContext = {
  id?: string;
};

export class TTLockHomeKeyPlatform implements DynamicPlatformPlugin {
  public readonly configuredAccessories: Map<string, PlatformAccessory<TTLockAccessoryContext>> = new Map();
  public ttLockApi: TTLockApi | null = null;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.api.on('didFinishLaunching', async () => {
      this.log.info('Finished launching TTLock Homebridge plugin');
      await this.createAndAuthenticateApi();
      await this.discoverDevices();
    });
  }

  private async createAndAuthenticateApi() {
    try {
      this.ttLockApi = new TTLockApi(this.log, this.config.clientId, this.config.clientSecret);
      await this.ttLockApi.authenticate(this.config.username, this.config.password);
      this.log.debug('Access token:', this.ttLockApi.accessToken);
      this.log.debug('Refresh token:', this.ttLockApi.refreshToken);
      this.log.info('Authenticated with TTLock API');
    } catch (error) {
      this.log.error('Failed to authenticate with TTLock API:', error);
    }
  }

  private async discoverDevices() {
    this.log.info('Discovering devices...');
    if (!this.ttLockApi) {
      this.log.error('TTLock API not initialized');
      return;
    }
    const locks = await this.ttLockApi.getLocks();
    for (const lock of locks) {
      const lockDetails: LockDetails = await this.ttLockApi.getLockDetails(lock.lockId);
      const lockState: LockState = await this.ttLockApi.getLockState(lock.lockId);
      const lockBattery: BatteryLevel = await this.ttLockApi.getBatteryLevel(lock.lockId);
      const lockPassCodes: PasscodeList = await this.ttLockApi.getPasscodes(lock.lockId);
      const lockNfcCards: NfcCardList = await this.ttLockApi.getNfcCards(lock.lockId);
      const detailedLock: Lock = await this.ttLockApi.mapToLock(lockDetails, lockState, lockBattery, lockPassCodes, lockNfcCards);
      new TTLockHomeKitDevice(this, detailedLock);
    }
  }

  registerPlatformAccessory(platformAccessory: PlatformAccessory<TTLockAccessoryContext>): void {
    this.log.debug('Registering platform platformAccessory:', platformAccessory.displayName);

    if (!this.configuredAccessories.has(platformAccessory.UUID)) {
      this.log.debug(`Platform Accessory ${platformAccessory.displayName} is not in configuredAccessories, adding it.`);
      this.configuredAccessories.set(platformAccessory.UUID, platformAccessory);
    } else {
      this.log.debug(`Platform Accessory ${platformAccessory.displayName} is already in configuredAccessories.`);
    }

    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [platformAccessory]);
    this.log.debug(`Platform Accessory ${platformAccessory.displayName} registered with Homebridge.`);
  }

  configureAccessory(platformAccessory: PlatformAccessory<TTLockAccessoryContext>): void {
    this.log.info(
      `Configuring cached accessory: [${platformAccessory.displayName}] UUID: ${platformAccessory.UUID} deviceId: ${
        platformAccessory.context.id
      }`,
    );
    if (!this.configuredAccessories.has(platformAccessory.UUID)) {
      this.log.debug(
        `Platform Accessory [${platformAccessory.displayName}] with UUID ` +
        `[${platformAccessory.UUID}] is not in configuredAccessories, adding it.`,
      );
      this.configuredAccessories.set(platformAccessory.UUID, platformAccessory);
    } else {
      this.log.debug(
        `Platform Accessory [${platformAccessory.displayName}] with UUID [${platformAccessory.UUID}] is already in configuredAccessories.`,
      );
    }
  }

  getServiceName(service: { UUID: string }): string {
    const serviceName = lookup(this.api.hap.Service, (thisKeyValue, value) =>
      isObjectLike(thisKeyValue) && 'UUID' in thisKeyValue && thisKeyValue.UUID === value, service.UUID);
    return serviceName;
  }

  getCharacteristicName(characteristic: WithUUID<{ name?: string | null; displayName?: string | null }>): string | undefined {
    const name = characteristic.name;
    const displayName = characteristic.displayName;
    const lookupName = lookupCharacteristicNameByUUID(this.api.hap.Characteristic, characteristic.UUID);
    return name ?? displayName ?? lookupName;
  }
}