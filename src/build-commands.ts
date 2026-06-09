/**
 * build-commands.ts
 * Uses centralized device schema cache from config.ts
 * Produces Companion action definitions and feedbacks
 */

import {
	CompanionActionDefinitions,
	CompanionActionDefinition,
	CompanionFeedbackDefinitions,
	combineRgb,
} from '@companion-module/base'
import { makeSettingId } from './types.js'
import { getDeviceSchemas } from './config.js'

function buildOption(o: any): any {
	const base = {
		type: o.type,
		id: o.id,
		label: o.label,
		default: o.default,
		tooltip: o.tooltip,
	}

	switch (o.type) {
		case 'dropdown':
			return { ...base, choices: o.choices ?? [] }

		case 'number':
			return {
				...base,
				min: o.min,
				max: o.max,
				step: o.step ?? 1,
				range: true,
			}

		case 'checkbox':
			return { ...base, default: o.default ?? false }

		case 'static-text':
			return { ...base, value: o.value ?? '' }

		case 'textinput':
		case 'colorpicker':
		default:
			return base
	}
}

export function buildActions(): CompanionActionDefinitions {
	const schemas = getDeviceSchemas()
	const actions: CompanionActionDefinitions = {}

	for (const [model, schema] of Object.entries(schemas)) {
		const cmdSchema = schema.cmdSchema
		if (!Array.isArray(cmdSchema)) continue

		for (const a of cmdSchema) {
			if (a.readonly === true) continue
			const actionId = makeSettingId(model, a.cmd_id, a.id)
			const allBuiltOptions = (a.options ?? []).map(buildOption)
			const options = a.value !== undefined ? allBuiltOptions.filter((o: any) => o.id !== 'value') : allBuiltOptions

			const action: CompanionActionDefinition = {
				name: `[Model${model}] ${a.name}`,
				options,
				callback: async () => {},
			}

			actions[actionId] = action
		}
	}

	return actions
}

function isBooleanDropdown(setting: any): boolean {
	const valueOpt = setting.options?.find((o: any) => o.id === 'value')
	if (!valueOpt) return false
	if (valueOpt.type === 'checkbox') return true
	if (valueOpt.type !== 'dropdown' || !Array.isArray(valueOpt.choices)) return false
	if (valueOpt.choices.length !== 2) return false
	const labels = valueOpt.choices.map((c: any) => String(c.label).toLowerCase())
	return labels.includes('off') && labels.includes('on')
}

export function buildFeedbacks(): CompanionFeedbackDefinitions {
	const schemas = getDeviceSchemas()
	const feedbacks: CompanionFeedbackDefinitions = {}

	for (const [model, schema] of Object.entries(schemas)) {
		const cmdSchema = schema.cmdSchema
		if (!Array.isArray(cmdSchema)) continue

		for (const setting of cmdSchema) {
			if (setting.writeonly === true) continue
			const baseFeedbackId = makeSettingId(model, setting.cmd_id, setting.id)

			if (setting.value !== undefined) {
				const fixedOptions = (setting.options ?? [])
					.map(buildOption)
					.filter((opt: any) => opt.id === 'busCh' || opt.id === 'idAdd')

				feedbacks[baseFeedbackId] = {
					type: 'boolean',
					name: `[Model${model}] ${setting.name} — Active`,
					defaultStyle: {
						bgcolor: combineRgb(0, 200, 0),
						color: combineRgb(0, 0, 0),
					},
					options: fixedOptions,
					callback: () => {
						return false
					},
				} as any
				continue
			}
			const allOptions = (setting.options ?? []).map(buildOption)
			const valueOptions = allOptions.filter((opt: any) => opt.id !== 'value')
			const isColorSetting = setting.options?.some((o: any) => o.id === 'value' && o.type === 'colorpicker')
			if (!isColorSetting) {
				valueOptions.push({
					type: 'checkbox',
					id: 'showLabel',
					label: 'Use Label for Value',
					default: false,
					tooltip: 'Return the label text instead of the numeric value',
				})
			}

			const valueFeedback: any = {
				type: 'value',
				name: `[Model${model}] ${setting.name}`,
				options: valueOptions,
				callback: () => {
					return 0
				},
			}

			feedbacks[baseFeedbackId] = valueFeedback

			if (isBooleanDropdown(setting)) {
				const boolFeedbackId = `${baseFeedbackId}_bool`
				const boolOptions = allOptions.filter((opt: any) => opt.id !== 'value')

				const boolFeedback: any = {
					type: 'boolean',
					name: `[Model${model}] ${setting.name} — Is On`,
					defaultStyle: {
						bgcolor: combineRgb(0, 200, 0),
						color: combineRgb(0, 0, 0),
					},
					options: boolOptions,
					callback: () => {
						/* wired later in UpdateFeedbacks */
						return false
					},
				}

				feedbacks[boolFeedbackId] = boolFeedback
			}
		}
	}

	return feedbacks
}
