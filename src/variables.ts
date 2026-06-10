import type ModuleInstance from './main.js'

export function UpdateVariableDefinitions(self: ModuleInstance): void {
	self.setVariableDefinitions({
		model: { name: 'Device Model Number' },
		modelName: { name: 'Device Model Name (Full Description)' },
		manufacturer: { name: 'Device Manufacturer' },
		firmware: { name: 'Device Firmware Version' },
		danteFW: { name: 'Dante Module Firmware Version' },
		mac: { name: 'Device MAC Address' },
		ip: { name: 'Device IP Address' },
	})
}

const CLEARED_VARIABLES = {
	model: '',
	modelName: '',
	manufacturer: '',
	firmware: '',
	danteFW: '',
	mac: '',
	ip: '',
}

export function UpdateVariableValues(self: ModuleInstance): void {
	const currentHost = self.host

	if (!currentHost || !self.stController.isDeviceAuthorized(currentHost)) {
		self.setVariableValues(CLEARED_VARIABLES)
		return
	}

	const device = self.devices.find((d) => d.ip === currentHost)
	if (device) {
		self.setVariableValues({
			model: device.model || '',
			modelName: device.modelName || '',
			manufacturer: device.manufacturer || '',
			firmware: device.firmwareMain || '',
			danteFW: device.danteFirmware || '',
			mac: device.mac || '',
			ip: device.ip,
		})
	} else {
		self.setVariableValues({
			...CLEARED_VARIABLES,
			ip: currentHost,
		})
	}
}
