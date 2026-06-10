import fs from 'fs'
import path from 'path'
import { Regex, type SomeCompanionConfigField, type JsonObject, createModuleLogger } from '@companion-module/base'
import type { DeviceInfo } from './types.js'

const logger = createModuleLogger('Config')

export type ModuleConfig = JsonObject & {
	deviceMac: string
	host: string
	activeModel: string
	devMode: boolean
}

function resolveDevicesFolder(): string {
	const primaryPath = path.join(import.meta.dirname, '../devices')
	const fallbackPath = path.join(import.meta.dirname, './devices')

	if (fs.existsSync(primaryPath)) {
		logger.debug(`Using devices folder: ${primaryPath}`)
		return primaryPath
	}

	if (fs.existsSync(fallbackPath)) {
		logger.warn(`Primary devices folder not found, using fallback: ${fallbackPath}`)
		return fallbackPath
	}

	const errorMsg = `Devices folder not found!\nTried:\n  - ${primaryPath}\n  - ${fallbackPath}\nModule cannot continue without device schemas.`
	logger.error(errorMsg)
	throw new Error(errorMsg)
}

const devicesFolder = resolveDevicesFolder()

let deviceSchemasCache: Record<string, any> | null = null

export function getDevicesFolder(): string {
	return devicesFolder
}

function loadDeviceSchemas(): Record<string, any> {
	const schemas: Record<string, any> = {}
	try {
		const files = fs.readdirSync(devicesFolder).filter((f) => f.endsWith('.json'))

		for (const f of files) {
			const fullPath = path.join(devicesFolder, f)
			const json = JSON.parse(fs.readFileSync(fullPath, 'utf8'))
			if (json?.model) {
				schemas[String(json.model)] = json
			}
		}

		logger.debug(`Loaded ${Object.keys(schemas).length} device schemas into cache`)
	} catch (e) {
		logger.error(`Failed to load device schemas: ${e}`)
	}
	return schemas
}

export function getDeviceSchemas(): Record<string, any> {
	if (!deviceSchemasCache) {
		deviceSchemasCache = loadDeviceSchemas()
	}
	return deviceSchemasCache
}

export function getDeviceSchema(model: string): any {
	const schemas = getDeviceSchemas()
	return schemas[model]
}

export function reloadDeviceSchemas(): void {
	logger.info('Reloading device schemas from disk...')
	deviceSchemasCache = loadDeviceSchemas()
}

function loadAvailableModels(): string[] {
	const schemas = getDeviceSchemas()
	return Object.keys(schemas).sort()
}

export function GetConfigFields(discoveredDevices: DeviceInfo[] = []): SomeCompanionConfigField[] {
	const models = loadAvailableModels()

	const deviceChoices = [
		{ id: '', label: 'Manual (enter IP + model below)' },
		...discoveredDevices.map((d) => ({
			id: d.mac ?? '',
			label: `Model ${d.model} [${d.mac}] @ ${d.ip}`,
		})),
	]

	return [
		{
			type: 'dropdown',
			id: 'deviceMac',
			label: 'Device',
			width: 8,
			default: '',
			choices: deviceChoices,
			tooltip: 'Select an auto-discovered Studio Technologies device, or choose Manual to enter an IP address.',
		},
		{
			type: 'textinput',
			id: 'host',
			label: 'Target IP',
			width: 8,
			default: '',
			regex: Regex.IP,
			isVisibleExpression: `!$(options:deviceMac)`,
			tooltip: 'Enter the IP address of the device manually.',
		},
		{
			type: 'dropdown',
			id: 'activeModel',
			label: 'Active Device Model',
			width: 8,
			default: models[0] ?? '',
			choices: models.map((model) => ({
				id: model,
				label: `Model ${model}`,
			})),
			isVisibleExpression: `!$(options:deviceMac)`,
			tooltip: 'Select which Studio Technologies model is active for actions and feedbacks.',
		},
		{
			type: 'checkbox',
			id: 'devMode',
			label: 'Dev Mode',
			width: 12,
			default: false,
			tooltip: 'Enable to allow parsing of ST Devices not currently supported',
		},
	]
}

export function resolveHost(config: ModuleConfig, discoveredDevices: DeviceInfo[]): string {
	if (config.deviceMac) {
		const device = discoveredDevices.find((d) => d.mac === config.deviceMac)
		return device?.ip ?? ''
	}
	return String(config.host ?? '')
}

export function resolveModel(config: ModuleConfig, discoveredDevices: DeviceInfo[]): string {
	if (config.deviceMac) {
		const device = discoveredDevices.find((d) => d.mac === config.deviceMac)
		logger.debug(`resolveModel: deviceMac="${config.deviceMac}", found device: ${device?.model ?? 'none'}`)
		return device?.model ?? ''
	}
	logger.debug(`resolveModel: manual mode, activeModel="${config.activeModel}"`)
	return String(config.activeModel ?? '')
}
