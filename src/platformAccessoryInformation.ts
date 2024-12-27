import type { HAP, PlatformAccessory, Service } from 'homebridge';

import type { TTLockHomeKitDevice } from './homekitDevice.js';

const colorValues: { [key: string]: string } = {
  Black: '000000',
  Gold: 'AAD6EC',
  Silver: 'E3E3E3',
  Tan: 'CED5DA',
};

export default function platformAccessoryInformation(
  hap: HAP,
  color: string,
): (platformAccessory: PlatformAccessory, homekitDevice: TTLockHomeKitDevice) => Service | undefined {
  const { Characteristic, Service: { AccessoryInformation } } = hap;
  const colorValue = colorValues[color] || colorValues['Tan'];

  return (platformAccessory: PlatformAccessory, homekitDevice: TTLockHomeKitDevice) => {
    const existingInfoService = platformAccessory.getService(AccessoryInformation);
    if (existingInfoService) {
      return existingInfoService;
    } else {
      const infoService = platformAccessory.addService(AccessoryInformation);

      infoService
        .setCharacteristic(Characteristic.Name, homekitDevice.name)
        .setCharacteristic(Characteristic.Manufacturer, homekitDevice.manufacturer)
        .setCharacteristic(Characteristic.Model, homekitDevice.model)
        .setCharacteristic(Characteristic.SerialNumber, homekitDevice.serialNumber)
        .setCharacteristic(Characteristic.FirmwareRevision, homekitDevice.firmwareRevision)
        .setCharacteristic(Characteristic.HardwareFinish, colorValue);

      return infoService;
    }
  };
}