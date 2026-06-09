import {
	InstanceTypes,
	InstanceBase,
	InstanceStatus,
	SomeCompanionConfigField,
	createModuleLogger,
} from '@companion-module/base'
import { GetConfigFields, resolveHost, resolveModel, getDeviceSchema, type ModuleConfig } from './config.js'
import { UpdateVariableDefinitions, UpdateVariableValues } from './variables.js'
import { UpgradeScripts } from './upgrades.js'
import { UpdateActions } from './actions.js'
import { UpdateFeedbacks } from './feedbacks.js'
import { StController } from './stcontroller.js'
import type { DeviceInfo } from './types.js'

const logger = createModuleLogger('ModuleInstance')

export type ModuleTypes = InstanceTypes & {
	config: ModuleConfig
}

export default class ModuleInstance extends InstanceBase<ModuleTypes> {
	config!: ModuleConfig
	stController!: StController
	private discoveredDevices: DeviceInfo[] = []
	activeModel: string = ''

	constructor(internal: unknown) {
		super(internal)
	}

	async init(config: ModuleConfig): Promise<void> {
		this.config = config
		if (!this.stController) {
			this.stController = new StController()
		}
		this.updateStatus(InstanceStatus.Connecting, 'Discovering devices...')
		this.stController.setFeedbackCallback((feedbackId: string) => {
			this.checkFeedbacks(feedbackId)
		})
		this.runDiscovery().catch((e) => {
			logger.error(`Discovery failed: ${e}`)
		})
	}

	private async runDiscovery(): Promise<void> {
		logger.info('Starting device discovery...')
		this.discoveredDevices = await this.stController.discoverDevices()
		let effectiveModel: string
		if (this.discoveredDevices.length === 0) {
			if (this.config.deviceMac) {
				logger.warn(`Saved device MAC "${this.config.deviceMac}" not found during discovery — stopping`)
				this.updateStatus(InstanceStatus.ConnectionFailure, `[${this.config.deviceMac}] not found`)
				return
			}
			const manualModel = this.config.activeModel
			if (!this.config.host || !manualModel) {
				logger.warn('No devices discovered and no manual IP/model configured')
				return
			}
			logger.info('No devices discovered — will probe manual IP during authorization')
			effectiveModel = manualModel
		} else {
			logger.info(`Discovered ${this.discoveredDevices.length} device(s):`)
			for (const d of this.discoveredDevices) {
				logger.info(`  - Model ${d.model} ${d.manufacturer ?? ''} @ ${d.ip}`)
			}
			for (const device of this.discoveredDevices) {
				this.stController.authorizeDevice(device.ip)
			}
			for (const device of this.discoveredDevices) {
				try {
					const firmware = await this.stController.requestFirmwareVersion(device.ip)
					device.firmwareMain = firmware
					logger.info(`  - ${device.ip}: Firmware ${firmware}, Dante ${device.danteFirmware}`)
				} catch (e) {
					logger.warn(`  - ${device.ip}: Failed to get firmware: ${e}`)
					device.firmwareMain = 'Unknown'
				}
			}

			effectiveModel = resolveModel(this.config, this.discoveredDevices)

			if (!effectiveModel && this.config.deviceMac) {
				logger.warn(`Saved device MAC "${this.config.deviceMac}" not found among discovered devices — stopping`)
				this.updateStatus(InstanceStatus.ConnectionFailure, `[${this.config.deviceMac}] not found`)
				return
			}
		}

		this.syncModel(effectiveModel)
		const targetHost = this.host
		await this.verifyAuthorization('', targetHost)
		this.updateActions()
		this.updateFeedbacks()
		this.updateVariableDefinitions()
		this.updateVariableValues()

		logger.info('Device discovery complete')
	}

	async destroy(): Promise<void> {
		this.stController?.close()
		logger.debug('destroy')
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		const previousHost = this.host
		this.config = config
		const effectiveModel = resolveModel(config, this.discoveredDevices)
		this.syncModel(effectiveModel)
		this.updateVariableValues()
		const newHost = this.host
		await this.verifyAuthorization(previousHost, newHost)
		this.updateActions()
		this.updateFeedbacks()
		this.updateVariableDefinitions()
		this.updateVariableValues()
	}

	private async verifyAuthorization(previousHost: string, newHost: string): Promise<void> {
		if (!newHost) {
			if (previousHost) this.stController.revokeDevice(previousHost)
			return
		}

		if (this.config.deviceMac) {
			// Auto mode — match by MAC, use whatever IP discovery found it at
			const device = this.discoveredDevices.find((d) => d.mac === this.config.deviceMac)
			if (!device) {
				logger.warn(`Device MAC "${this.config.deviceMac}" not found in current discovery — not authorizing`)
				if (previousHost) this.stController.revokeDevice(previousHost)
				return
			}

			if (previousHost && previousHost !== newHost) {
				this.stController.revokeDevice(previousHost)
			}
			const wasAuthorized = this.stController.isDeviceAuthorized(newHost)
			if (!wasAuthorized) {
				this.stController.authorizeDevice(newHost)
			}
			if (newHost !== previousHost || !wasAuthorized) {
				await this.fetchSettingsAndEnsureSchema(device.model, newHost)
			}
			this.updateStatus(InstanceStatus.Ok, `Model ${device.model} @ ${newHost}`)
			return
		}

		// Manual mode — config.host + config.activeModel must match
		const manualModel = String(this.config.activeModel ?? '')
		const discoveredAtIp = this.discoveredDevices.find((d) => d.ip === newHost)

		if (discoveredAtIp) {
			if (discoveredAtIp.model === manualModel) {
				if (previousHost && previousHost !== newHost) this.stController.revokeDevice(previousHost)
				const wasAuthorized = this.stController.isDeviceAuthorized(newHost)
				if (!wasAuthorized) {
					this.stController.authorizeDevice(newHost)
				}
				if (newHost !== previousHost || !wasAuthorized) {
					await this.fetchSettingsAndEnsureSchema(manualModel, newHost)
				}
				this.updateStatus(InstanceStatus.Ok, `Model ${manualModel} @ ${newHost}`)
			} else {
				logger.error(
					`Device selected (Model ${manualModel}) does not match detected device (Model ${discoveredAtIp.model}) at ${newHost} — commands blocked`,
				)
				this.stController.revokeDevice(newHost)
				this.updateStatus(
					InstanceStatus.ConnectionFailure,
					`Model mismatch: expected ${manualModel}, got ${discoveredAtIp.model}`,
				)
			}
			return
		}

		logger.info(`${newHost} not in discovered list — probing`)
		if (previousHost && previousHost !== newHost) this.stController.revokeDevice(previousHost)
		this.stController.revokeDevice(newHost)

		const probed = await this.stController.probeDevice(newHost)
		if (!probed) {
			logger.error(`No device responded at ${newHost} — commands blocked`)
			this.updateStatus(InstanceStatus.UnknownWarning, `Device offline: ${newHost}`)
		} else if (probed.model !== manualModel) {
			logger.error(
				`Device selected (Model ${manualModel}) does not match detected device (Model ${probed.model}) at ${newHost} — commands blocked`,
			)
			this.updateStatus(
				InstanceStatus.ConnectionFailure,
				`Model mismatch: expected ${manualModel}, got ${probed.model}`,
			)
		} else {
			logger.info(`Verified Model ${probed.model} at ${newHost}`)
			this.stController.authorizeDevice(newHost)
			await this.fetchSettingsAndEnsureSchema(manualModel, newHost)
			this.updateStatus(InstanceStatus.Ok, `Model ${probed.model} @ ${newHost}`)
		}
	}

	private async fetchSettingsAndEnsureSchema(model: string, ip: string): Promise<void> {
		try {
			await this.stController.requestAllSettings(ip)
			if (!getDeviceSchema(model)) {
				logger.warn(`No schema found for Model ${model} — run "GLOBAL: Get All Settings" to create one`)
				return
			}
		} catch (e) {
			logger.warn(`Failed to fetch settings from ${ip}: ${e}`)
		}
	}

	private syncModel(model: string): void {
		this.activeModel = model
		const schema = getDeviceSchema(model)
		if (!schema) {
			logger.warn(`Model "${model}" not found in device schemas`)
			this.stController.setModel(model, [])
			return
		}

		const actions = Array.isArray(schema.cmdSchema) ? schema.cmdSchema : []

		this.stController.setModel(model, actions)
		if (actions.length === 0) {
			logger.warn(`No actions found for model "${model}" — settings decoding will use raw IDs`)
		} else {
			logger.debug(`Loaded ${actions.length} actions for model "${model}"`)
		}
	}

	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields(this.discoveredDevices)
	}

	get host(): string {
		return resolveHost(this.config, this.discoveredDevices)
	}

	get devices(): DeviceInfo[] {
		return this.discoveredDevices
	}

	updateActions(): void {
		UpdateActions(this)
	}

	updateFeedbacks(): void {
		UpdateFeedbacks(this)
	}

	updateVariableDefinitions(): void {
		UpdateVariableDefinitions(this)
	}

	updateVariableValues(): void {
		UpdateVariableValues(this)
	}
}

export { UpgradeScripts }
