/**
 * build-commands.ts
 * - Uses centralized device schema cache from config.ts
 * - Produces Companion action definitions and feedbacks
 */

import {
	CompanionActionDefinitions,
	CompanionActionDefinition,
	CompanionFeedbackDefinitions,
	combineRgb,
} from '@companion-module/base'
import { makeSettingId } from './types.js'
import { getDeviceSchemas } from './config.js'

/* ----------------------------- */
/* ------ Option Builder ------- */
/* ----------------------------- */

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

/* ----------------------------- */
/* --------- Actions ----------- */
/* ----------------------------- */

export function buildActions(): CompanionActionDefinitions {
	const schemas = getDeviceSchemas()
	const actions: CompanionActionDefinitions = {}

	for (const [model, schema] of Object.entries(schemas)) {
		const cmdSchema = schema.cmdSchema
		if (!Array.isArray(cmdSchema)) continue

		for (const a of cmdSchema) {
			// Skip read-only entries — they are feedback-only (indicators, status)
			if (a.readonly === true) continue

			const actionId = makeSettingId(model, a.cmd_id, a.id)

			const options = (a.options ?? []).map(buildOption)

			const action: CompanionActionDefinition = {
				name: `[Model${model}] ${a.name}`,
				options,
				callback: async () => {
					/* wired later in UpdateActions */
				},
			}

			actions[actionId] = action
		}
	}

	return actions
}

/* ----------------------------- */
/* --------- Feedbacks --------- */
/* ----------------------------- */

/**
 * Returns true if the value option of a schema entry is a simple Off/On dropdown
 * (exactly two choices, one labelled "Off" and one labelled "On").
 */
function isOnOffDropdown(setting: any): boolean {
	const valueOpt = setting.options?.find((o: any) => o.id === 'value')
	if (!valueOpt || valueOpt.type !== 'dropdown' || !Array.isArray(valueOpt.choices)) return false
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
			// Skip write-only entries — they are action-only (device never reports value back)
			if (setting.writeonly === true) continue

			const baseFeedbackId = makeSettingId(model, setting.cmd_id, setting.id)

			// Build options
			const allOptions = (setting.options ?? []).map(buildOption)

			// Filter out 'value' option for value feedback (keep only busCh/idAdd)
			const valueOptions = allOptions.filter((opt: any) => opt.id !== 'value')

			// Add a checkbox option to return label instead of value
			valueOptions.push({
				type: 'checkbox',
				id: 'showLabel',
				label: 'Use Label for Value',
				default: false,
				tooltip: 'Return the label text instead of the numeric value',
			})

			// Value feedback for all settings (appears in Variables list)
			const valueFeedback: any = {
				type: 'value',
				name: `[Model${model}] ${setting.name}`,
				options: valueOptions,
				callback: () => {
					/* wired later in UpdateFeedbacks */
					return 0
				},
			}

			// Boolean feedback for Off/On dropdowns — replaces the value feedback
			if (isOnOffDropdown(setting)) {
				const boolFeedbackId = `${baseFeedbackId}_bool`

				// Options without 'value' (busCh/idAdd selectors only, if present)
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
			} else {
				feedbacks[baseFeedbackId] = valueFeedback
			}
		}
	}

	return feedbacks
}
