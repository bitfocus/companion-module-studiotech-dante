export type DeviceInfo = {
	model: string
	modelName?: string
	ip: string
	name?: string
	manufacturer?: string
	firmwareMain?: string
	danteFirmware?: string
	mac?: string
}

export const CMD_GET_FIRMWARE = 0x00
export const CMD_MIC_PRE = 0x02
export const CMD_BUS_GET = 0x03
export const CMD_BUS_SET = 0x04
export const CMD_HEADPHONE = 0x05
export const CMD_BUTTON_MODE = 0x07
export const CMD_SYSTEM = 0x09
export const CMD_GET_ALL_SETTINGS = 0x0a
export const CMD_SETTINGS_PUSH = 0x0b
export const CMD_DEV_SPEC = 0x0d
export const CMD_RESET_DEVICE = 0x0e
export const CMD_GLOBAL_MIC_KILL = 0x10
export const CMD_MIC_PRE_BUS = 0x12
export const CMD_CHANNEL = 0x14

export function getCommandName(cmdId: number): string {
	switch (cmdId) {
		case CMD_GET_FIRMWARE:
			return 'Get Firmware Version'
		case CMD_MIC_PRE:
			return 'Mic Preamp'
		case CMD_BUS_GET:
			return 'Heartbeat'
		case CMD_BUS_SET:
			return 'Set Bus Setting'
		case CMD_HEADPHONE:
			return 'Headphone Control'
		case CMD_BUTTON_MODE:
			return 'Button Mode'
		case CMD_SYSTEM:
			return 'System Command'
		case CMD_GET_ALL_SETTINGS:
			return 'Request All Settings'
		case CMD_SETTINGS_PUSH:
			return 'Settings Push'
		case CMD_MIC_PRE_BUS:
			return 'Mic/Pre Bus'
		case CMD_DEV_SPEC:
			return 'Device Setting'
		case CMD_CHANNEL:
			return 'Channel Setting'
		case CMD_RESET_DEVICE:
			return 'Reset Device'
		case CMD_GLOBAL_MIC_KILL:
			return 'Global Mic Kill'
		default:
			return `cmd_0x${cmdId.toString(16).padStart(2, '0')}`
	}
}

export function makeSettingId(
	model: string,
	cmdId: number | string,
	settingId: number | string,
	busCh?: number | string,
): string {
	const cmd = typeof cmdId === 'number' ? cmdId.toString(16) : cmdId
	const id = typeof settingId === 'number' ? settingId.toString(16) : settingId

	if (busCh !== undefined) {
		const ch = typeof busCh === 'number' ? busCh.toString(16) : busCh
		return `${model}_${cmd}_${ch}_${id}`
	}

	return `${model}_${cmd}_${id}`
}

export function toHex(value: number, padLength = 2): string {
	return `0x${value.toString(16).padStart(padLength, '0')}`
}

export function bytesToHex(bytes: number[] | Buffer): string {
	return `0x${Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')}`
}

export function formatRgbColor(r: number, g: number, b: number): string {
	return `#${[r, g, b]
		.map((v) => v.toString(16).padStart(2, '0'))
		.join('')
		.toUpperCase()}`
}

export function parseSettingId(id: string): { model: string; cmdId: number; baseId: number } {
	const [model, cmdIdStr, idStr] = id.split('_')
	return {
		model,
		cmdId: parseInt(cmdIdStr, 16),
		baseId: parseInt(idStr, 16),
	}
}

export function modelDistance(modelA: string, modelB: string): number {
	const na = parseInt(modelA.replace(/\D/g, ''), 10)
	const nb = parseInt(modelB.replace(/\D/g, ''), 10)
	if (Number.isNaN(na) || Number.isNaN(nb)) return Infinity
	return Math.abs(na - nb)
}

export function getNormalizedSchemas(
	schemasRaw: Record<string, any>,
): Record<string, { model: string; cmdSchema: any[] }> {
	const normalized: Record<string, { model: string; cmdSchema: any[] }> = {}
	for (const [model, json] of Object.entries(schemasRaw)) {
		normalized[model] = {
			model: json.model,
			cmdSchema: Array.isArray(json.cmdSchema) ? json.cmdSchema : [],
		}
	}
	return normalized
}

export function findActionForSetting(
	schemas: Record<string, { model: string; cmdSchema: any[] }>,
	model: string,
	cmdId: number,
	settingId: number,
): any {
	const schema = schemas[model]
	if (!schema || !Array.isArray(schema.cmdSchema)) return undefined

	// Try exact match first
	let action = schema.cmdSchema.find((s: any) => s.cmd_id === cmdId && s.id === settingId)

	// If no exact match, try to find base action with idAdd
	if (!action) {
		action = schema.cmdSchema.find((s: any) => {
			if (s.cmd_id !== cmdId) return false
			const idAddOption = s.options?.find((opt: any) => opt.id === 'idAdd')
			if (!idAddOption?.choices) return false
			// Check if settingId matches base + any idAdd offset
			const offset = settingId - s.id
			return idAddOption.choices.some((c: any) => c.id === offset)
		})
	}

	return action
}
