import ModuleInstance from './main.js'
import { buildActions } from './build-commands.js'
import { getDevicesFolder, getDeviceSchema, getDeviceSchemas, reloadDeviceSchemas } from './config.js'
import { parseSettingId, getNormalizedSchemas } from './types.js'
import { createModuleLogger } from '@companion-module/base'
import path from 'path'

import { parseGetAllSettingsWithDetection, saveModelJsonPretty, updateModelJsonFromSettings } from './settingsParser.js'

const logger = createModuleLogger('Actions')

export function UpdateActions(self: ModuleInstance): void {
	const schemasRaw = getDeviceSchemas()
	const rawActions = buildActions()
	const schemas = getNormalizedSchemas(schemasRaw)
	const wiredActions: any = {}

	const activeModel = self.activeModel

	// ---------------------------------------------
	// ✅ GLOBAL: GET ALL SETTINGS (AUTO JSON UPDATE) — Dev Mode only
	// ---------------------------------------------

	if (self.config.devMode) {
		wiredActions['global_getAllSettings'] = {
			name: 'GLOBAL: Get All Settings',
			description: 'Use this to create a schema for a new device',
			options: [],
			callback: async () => {
				const model = activeModel
				const ip = self.host

				const buf = await self.stController.requestAllSettings(ip)

				let modelJson = getDeviceSchema(model)

				const { settings: parsed } = parseGetAllSettingsWithDetection(model, buf)
				logger.debug(`parsed reply: ${JSON.stringify(parsed)}`)

				if (!modelJson) {
					logger.info(`Model ${model} has no schema — creating new JSON from settings`)
					modelJson = {
						model,
						cmdSchema: [],
					}
				}

				const updated = updateModelJsonFromSettings(modelJson, parsed, schemas)
				logger.debug(`new Actions json: ${JSON.stringify(updated, null, 2)}`)

				const devicesFolder = getDevicesFolder()
				const schemaPath = path.join(devicesFolder, `Model${model}.json`)
				saveModelJsonPretty(schemaPath, updated)

				reloadDeviceSchemas()

				logger.info(`Model ${model} JSON auto-updated from getAllSettings`)
			},
		}
	}

	// ---------------------------------------------
	// ✅ BUILD PER-SETTING ACTIONS (FILTERED BY ACTIVE MODEL)
	// ---------------------------------------------

	for (const [actionId, action] of Object.entries(rawActions)) {
		const { model, cmdId, baseId } = parseSettingId(actionId)

		// Only include actions for the currently active model
		if (model !== activeModel) continue

		// Get the raw action schema to access fixed busCh value
		const schema = schemas[model]
		const rawAction = schema?.cmdSchema?.find((a: any) => a.cmd_id === cmdId && a.id === baseId)

		wiredActions[actionId] = {
			...action,
			callback: async (event: any) => {
				const ip = self.host
				const busCh = event.options['busCh'] !== undefined ? event.options['busCh'] : rawAction?.busCh
				const value = event.options['value']
				const idAdd = event.options['idAdd'] ?? 0
				const settingId = baseId + idAdd

				await self.stController.sendAwaitAck(cmdId, busCh, settingId, value, ip)
			},
			learn: (event: any) => {
				const ip = self.host
				const idAdd = event.options['idAdd'] ?? 0
				const settingId = baseId + idAdd
				const busCh = event.options['busCh'] !== undefined ? event.options['busCh'] : rawAction?.busCh

				const current = self.stController.getSettingValue(ip, cmdId, settingId, busCh)
				if (current === undefined) return undefined

				return { ...event.options, value: current }
			},
		}
	}

	// ---------------------------------------------
	// ✅ MIC KILL (ONLY IF ACTIVE MODEL SUPPORTS IT)
	// ---------------------------------------------
	const activeSchema = schemas[activeModel]
	if (activeSchema) {
		const supportsMicKill = (activeSchema.cmdSchema ?? []).some((a: any) => a.name.includes('Kill'))

		if (supportsMicKill) {
			const actionId = `${activeModel}_micKill`

			wiredActions[actionId] = {
				name: `[Model${activeModel}] Mic Kill`,
				options: [],
				callback: async () => {
					const ip = self.host
					logger.info(`Mic Kill → Model ${activeModel} @ ${ip}`)
					await self.stController.globalMicKill(ip)
					await self.stController.requestAllSettings(ip).catch((err) => {
						logger.warn(`Failed to refresh settings after command: ${err}`)
					})
				},
			}
		}
	}

	self.setActionDefinitions(wiredActions)
}
