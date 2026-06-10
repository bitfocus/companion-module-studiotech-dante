import ModuleInstance from './main.js'
import { buildFeedbacks } from './build-commands.js'
import { getDeviceSchemas } from './config.js'
import { parseSettingId, getNormalizedSchemas, findActionForSetting } from './types.js'

function getLabelForValue(
	schemas: Record<string, { model: string; cmdSchema: any[] }>,
	model: string,
	cmdId: number,
	settingId: number,
	value: number,
): string | number {
	const setting = findActionForSetting(schemas, model, cmdId, settingId)
	if (!setting || !Array.isArray(setting.options)) return value

	const valueOption = setting.options.find((opt: any) => opt.id === 'value')
	if (!valueOption || !Array.isArray(valueOption.choices)) return value

	const choice = valueOption.choices.find((c: any) => c.id === value)
	return choice?.label ?? value
}

/**
 * Build and wire Companion feedback definitions
 * Pattern matches actions.ts - filters by active model and wires callbacks
 */
export function UpdateFeedbacks(self: ModuleInstance): void {
	const schemasRaw = getDeviceSchemas()
	const rawFeedbacks = buildFeedbacks()
	const schemas = getNormalizedSchemas(schemasRaw)
	const wiredFeedbacks: any = {}

	const activeModel = self.activeModel

	for (const [feedbackId, feedback] of Object.entries(rawFeedbacks)) {
		const parseId = feedbackId.endsWith('_bool') ? feedbackId.slice(0, -5) : feedbackId
		const { model, cmdId, baseId } = parseSettingId(parseId)

		if (model !== activeModel) continue

		wiredFeedbacks[feedbackId] = {
			...feedback,
			callback: (feedbackEvent: any) => {
				const ip = self.host
				const idAdd = feedbackEvent.options['idAdd'] ?? 0
				const settingId = baseId + idAdd

				let busCh = feedbackEvent.options['busCh']
				if (busCh === undefined) {
					const schemaAction = findActionForSetting(schemas, model, cmdId, settingId)
					if (schemaAction?.busCh !== undefined) {
						busCh = schemaAction.busCh
					}
				}
				if (busCh === undefined) {
					const rawAction = schemasRaw[model]?.cmdSchema?.find((a: any) => a.cmd_id === cmdId && a.id === settingId)
					if (rawAction?.busCh !== undefined) {
						busCh = rawAction.busCh
					}
				}

				const current = self.stController.getSettingValue(ip, cmdId, settingId, busCh)

				if (feedbackId.endsWith('_bool')) {
					return current !== undefined && current !== 0
				}

				const showLabel = feedbackEvent.options['showLabel'] ?? false

				if (showLabel && current !== undefined) {
					const label = getLabelForValue(schemas, model, cmdId, settingId, current)
					if (typeof label === 'number') {
						return label !== 0 ? 'true' : 'false'
					}
					return label
				}

				return current ?? 0
			},
		}
	}

	self.setFeedbackDefinitions(wiredFeedbacks)
}
