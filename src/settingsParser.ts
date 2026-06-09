import fs from 'fs'
import { getDeviceSchema } from './config.js'
import { createModuleLogger } from '@companion-module/base'
import {
	CMD_MIC_PRE,
	CMD_BUS_SET,
	CMD_CHANNEL,
	CMD_GET_ALL_SETTINGS,
	CMD_MIC_PRE_BUS,
	CMD_SETTINGS_PUSH,
	toHex,
	bytesToHex,
	formatRgbColor,
	modelDistance,
} from './types.js'

const logger = createModuleLogger('SettingsParser')

export type ParsedSetting = {
	cmd_id: number
	id: number
	busCh?: number
	valueBytes: number[]
}

export type StActionOption = {
	id?: string
	label: string
	type: string
	default: unknown
	tooltip?: string
	choices?: Array<{ id: number; label: string }>
}

export type StAction = {
	cmd_id: number
	id: number
	name: string
	options: StActionOption[]
	busCh?: number
	value?: number
	readonly?: boolean
	writeonly?: boolean
}

export type StModelJson = {
	model: string
	useConMon?: boolean
	cmdSchema: StAction[]
}

function getRgbIds(model: string): Set<number> {
	const rgbIds = new Set<number>()
	try {
		const json = getDeviceSchema(model)
		if (!json) return rgbIds
		for (const action of json.cmdSchema || []) {
			const hasColorpicker = action.options?.some((opt: StActionOption) => opt.type === 'colorpicker')
			if (hasColorpicker) {
				rgbIds.add(action.id)
				const idAddOption = action.options?.find((opt: StActionOption) => opt.id === 'idAdd')
				if (idAddOption?.choices) {
					for (const choice of idAddOption.choices) {
						if (typeof choice.id === 'number') {
							rgbIds.add(action.id + choice.id)
						}
					}
				}
			}
		}
	} catch (_err) {
		// return empty set on error
	}
	return rgbIds
}

function extractStPayloadIndex(buf: Buffer): number {
	const sigIndex = buf.indexOf(Buffer.from('Studio-T'))
	if (sigIndex < 0) throw new Error('No Studio-T signature in packet')
	const payloadIndex = sigIndex + 8
	if (buf[payloadIndex] !== 0x5a) {
		throw new Error(`Expected 0x5A after Studio-T, found ${buf[payloadIndex].toString(16)}`)
	}
	return payloadIndex
}

function parseGetAllSettings_sectioned(buf: Buffer, model: string): ParsedSetting[] {
	const idx = extractStPayloadIndex(buf)
	const cmdId = buf[idx + 1] & 0x7f
	if (cmdId !== CMD_GET_ALL_SETTINGS && cmdId !== CMD_SETTINGS_PUSH) {
		throw new Error('Not a getAllSettings reply')
	}

	let p = cmdId === CMD_GET_ALL_SETTINGS ? idx + 3 : idx + 2
	const end = buf.length - 1
	const out: ParsedSetting[] = []
	const rgbIds = getRgbIds(model)
	const commandsWithBusCh = [CMD_BUS_SET, CMD_MIC_PRE_BUS, CMD_CHANNEL]
	const commandsRawValue = [CMD_MIC_PRE]

	while (p + 2 < end) {
		const cmdLen = buf[p]
		const sectionCmdId = buf[p + 1]
		const sectionEnd = p + 1 + cmdLen
		if (sectionEnd > end) break

		const hasBusCh = commandsWithBusCh.includes(sectionCmdId)
		const isRawValue = commandsRawValue.includes(sectionCmdId)

		let busCh: number | undefined
		let dataLen: number
		let q: number

		if (isRawValue) {
			busCh = buf[p + 2]
			const rawBytes = buf.subarray(p + 3, sectionEnd)
			const schema = getDeviceSchema(model)
			const micPreEntries = (schema?.cmdSchema ?? [])
				.filter((a: StAction) => (a.cmd_id === CMD_MIC_PRE || a.cmd_id === CMD_MIC_PRE_BUS) && a.busCh !== undefined)
				.sort((a: StAction, b: StAction) => a.id - b.id)
			for (let i = 0; i < rawBytes.length; i++) {
				const entry = micPreEntries[i]
				if (entry) {
					out.push({ cmd_id: entry.cmd_id, id: entry.id, busCh, valueBytes: [rawBytes[i]] })
				}
			}
			p = sectionEnd
			continue
		} else if (hasBusCh) {
			busCh = buf[p + 2]
			dataLen = buf[p + 3]
			q = p + 4
		} else {
			dataLen = buf[p + 2]
			q = p + 3
		}

		const qEnd = q + dataLen
		const qStart = q

		while (q + 1 < qEnd) {
			const id = buf[q]
			let valueBytes: number[]
			if (rgbIds.has(id) && q + 3 < qEnd) {
				valueBytes = [buf[q + 1], buf[q + 2], buf[q + 3]]
				q += 4
			} else {
				valueBytes = [buf[q + 1]]
				q += 2
			}
			const setting: ParsedSetting = { cmd_id: sectionCmdId, id, valueBytes }
			if (busCh !== undefined) setting.busCh = busCh
			out.push(setting)
		}

		if (q === qStart && sectionEnd > p + 3) {
			let pos = hasBusCh ? p + 3 : p + 2
			let posId = 0
			while (pos < sectionEnd) {
				const setting: ParsedSetting = { cmd_id: sectionCmdId, id: posId++, valueBytes: [buf[pos++]] }
				if (busCh !== undefined) setting.busCh = busCh
				out.push(setting)
			}
		}

		p = sectionEnd
	}

	return out
}

export function parseSettingsResponse(model: string, buf: Buffer): ParsedSetting[] {
	const idx = extractStPayloadIndex(buf)
	const cmdId = buf[idx + 1] & 0x7f
	if (cmdId !== CMD_GET_ALL_SETTINGS && cmdId !== CMD_SETTINGS_PUSH) {
		throw new Error(`Not a settings block (cmdId=0x${cmdId.toString(16)})`)
	}
	return parseGetAllSettings_sectioned(buf, model)
}

export function formatParsedSetting(setting: ParsedSetting, actions: StAction[]): string {
	let action = actions.find((a) => a.cmd_id === setting.cmd_id && a.id === setting.id)

	if (!action) {
		const baseAction = actions.find((a) => {
			if (a.cmd_id !== setting.cmd_id) return false
			const idAddOption = a.options?.find((opt) => opt.id === 'idAdd')
			if (!idAddOption?.choices) return false
			const channelOffset = setting.id - a.id
			return idAddOption.choices.some((c) => c.id === channelOffset)
		})
		if (baseAction) action = baseAction
	}

	const cmdHex = toHex(setting.cmd_id)
	const idHex = toHex(setting.id)
	const valHex = bytesToHex(setting.valueBytes)
	const valDec =
		setting.valueBytes.length === 3
			? formatRgbColor(setting.valueBytes[0], setting.valueBytes[1], setting.valueBytes[2])
			: setting.valueBytes.length === 1
				? setting.valueBytes[0]
				: setting.valueBytes.join(',')

	const busChStr = setting.busCh !== undefined ? ` ch:${setting.busCh}` : ''
	const prefix = `cmd:${cmdHex}${busChStr} id:${idHex} val:${valHex}`

	if (action) {
		let name = action.name

		if (setting.busCh !== undefined) {
			name = `${name} Ch${setting.busCh + 1}`
		} else {
			const idAddOption = action.options?.find((opt) => opt.id === 'idAdd')
			if (idAddOption?.choices) {
				const channelOffset = setting.id - action.id
				const idAddChoice = idAddOption.choices.find((c) => c.id === channelOffset)
				if (idAddChoice) name = `${name} ${idAddChoice.label}`
			}
		}

		const valueOption = action.options?.find((opt) => opt.id === 'value')
		const fixedValue = (action as any).value
		if (fixedValue !== undefined && valueOption === undefined) {
			return `${prefix} | ${name}: ${fixedValue}`
		}
		if (valueOption?.choices && setting.valueBytes.length === 1) {
			const choice = valueOption.choices.find((c) => c.id === setting.valueBytes[0])
			if (choice) return `${prefix} | ${name}: ${choice.label} (${valDec})`
		}
		return `${prefix} | ${name}: ${valDec}`
	}

	return `${prefix} | Unknown Setting`
}

export function parseGetAllSettingsWithDetection(
	model: string,
	buf: Buffer,
): { settings: ParsedSetting[]; detectedSectioned: null } {
	const settings = parseGetAllSettings_sectioned(buf, model)
	return { settings, detectedSectioned: null }
}

export function parseGetAllSettingsForModel(model: string, buf: Buffer): ParsedSetting[] {
	return parseGetAllSettings_sectioned(buf, model)
}

function valueBytesToOption(valueBytes: number[]): StActionOption {
	if (valueBytes.length === 1) {
		return { id: 'value', label: 'Value', type: 'number', default: valueBytes[0] }
	}
	if (valueBytes.length === 3) {
		const [r, g, b] = valueBytes
		return { id: 'value', label: 'Color', type: 'colorpicker', default: formatRgbColor(r, g, b) }
	}
	return { id: 'value', label: 'Value', type: 'raw', default: [...valueBytes] }
}

export function updateModelJsonFromSettings(
	modelJson: StModelJson,
	parsed: ParsedSetting[],
	allModels: Record<string, StModelJson>,
): StModelJson {
	const out = structuredClone(modelJson)
	if (!out.cmdSchema) out.cmdSchema = []

	const candidates = Object.values(allModels)
		.filter((m) => m.model !== modelJson.model)
		.sort((a, b) => modelDistance(modelJson.model, a.model) - modelDistance(modelJson.model, b.model))

	logger.info(`Updating model: ${modelJson.model}`)
	logger.debug(`Candidates for inference: ${candidates.map((c) => c.model).join(', ')}`)

	const idAddDeferRanges = new Map<string, number>()
	for (const c of candidates) {
		for (const baseEntry of c.cmdSchema ?? []) {
			const idAddOpt = baseEntry.options?.find((o: any) => o.id === 'idAdd')
			if (!idAddOpt?.choices) continue
			const baseId = baseEntry.id
			const cmdId = baseEntry.cmd_id
			const key = `${cmdId}_${baseId}`
			if (idAddDeferRanges.has(key)) continue
			const parsedOffsets = parsed
				.filter((p) => p.cmd_id === cmdId && p.id > baseId)
				.map((p) => p.id - baseId)
				.sort((a, b) => a - b)
			let maxSeq = 0
			for (const off of parsedOffsets) {
				if (off === maxSeq + 1) maxSeq = off
				else if (off > maxSeq + 1) break
			}
			if (maxSeq > 0) {
				idAddDeferRanges.set(key, maxSeq)
				logger.debug(`idAdd defer range for cmd_id=${toHex(cmdId)} base_id=${toHex(baseId)}: offsets 1–${maxSeq}`)
			}
		}
	}

	const busChSeen = new Map<string, Set<number>>()
	for (const { cmd_id, id, busCh } of parsed) {
		if (busCh === undefined) continue
		const key = `${cmd_id}_${id}`
		if (!busChSeen.has(key)) busChSeen.set(key, new Set())
		busChSeen.get(key)!.add(busCh)
	}

	for (const { cmd_id, id, busCh, valueBytes } of parsed) {
		const existingExact = out.cmdSchema.find((a) => a.cmd_id === cmd_id && a.id === id)
		if (existingExact) {
			const opt = existingExact.options?.find((o) => o.id === 'value')
			if (opt) opt.default = valueBytesToOption(valueBytes).default
			const seenBusChValues = busChSeen.get(`${cmd_id}_${id}`)
			if (seenBusChValues && seenBusChValues.size > 0) {
				const maxBusCh = Math.max(...seenBusChValues)
				const hasBusChOption = existingExact.options?.some((o) => o.id === 'busCh')
				if (maxBusCh === 0 && existingExact.busCh === undefined && !hasBusChOption) {
					existingExact.busCh = 0
					logger.info(`Synced busCh=0 onto existing entry cmd_id=${toHex(cmd_id)} id=${toHex(id)}`)
				}
			}
			continue
		}

		const idAddBase = out.cmdSchema.find((a) => {
			if (a.cmd_id !== cmd_id) return false
			const idAddOpt = a.options?.find((o) => o.id === 'idAdd')
			if (!idAddOpt?.choices) return false
			if (id <= a.id) return false
			const offset = id - a.id
			return candidates.some((c) => {
				const refEntry = c.cmdSchema?.find((r) => r.cmd_id === cmd_id && r.id === a.id)
				const refIdAdd = refEntry?.options?.find((o) => o.id === 'idAdd')
				return refIdAdd?.choices?.some((ch: any) => ch.id === offset)
			})
		})
		if (idAddBase) {
			const offset = id - idAddBase.id
			const idAddOpt = idAddBase.options?.find((o) => o.id === 'idAdd')
			if (idAddOpt?.choices && !idAddOpt.choices.some((c: any) => c.id === offset)) {
				let label = `Channel ${offset + 1}`
				for (const c of candidates) {
					const refEntry = c.cmdSchema?.find((a) => a.cmd_id === cmd_id && a.id === idAddBase.id)
					const refIdAdd = refEntry?.options?.find((o) => o.id === 'idAdd')
					const refChoice = refIdAdd?.choices?.find((ch: any) => ch.id === offset)
					if (refChoice) {
						label = refChoice.label
						break
					}
				}
				idAddOpt.choices.push({ id: offset, label })
				logger.info(
					`Folded cmd_id=${toHex(cmd_id)} id=${toHex(id)} into idAdd base id=${toHex(idAddBase.id)} as offset ${offset} ("${label}")`,
				)
			}
			continue
		}

		let action: StAction | undefined

		for (const c of candidates) {
			const match = c.cmdSchema?.find((a) => a.cmd_id === cmd_id && a.id === id)
			if (match) {
				action = structuredClone(match)
				const baseName = match.name.replace(/\s*\(inferred from Model [^)]+\)/g, '').trim()
				action.name = `${baseName} (inferred from Model ${c.model})`
				logger.info(`Inferred cmd_id=${toHex(cmd_id)} id=${toHex(id)} from Model ${c.model} (exact)`)
				break
			}
		}

		if (!action) {
			let shouldDefer = false
			for (const c of candidates) {
				const baseEntry = c.cmdSchema?.find((a: any) => {
					if (a.cmd_id !== cmd_id) return false
					const idAddOpt = a.options?.find((o: any) => o.id === 'idAdd')
					if (!idAddOpt?.choices) return false
					if (id <= a.id) return false
					const offset = id - a.id
					const maxSeq = idAddDeferRanges.get(`${cmd_id}_${a.id}`) ?? 0
					return offset <= maxSeq
				})
				if (baseEntry) {
					shouldDefer = true
					logger.debug(
						`cmd_id=${toHex(cmd_id)} id=${toHex(id)} is an idAdd offset of candidate base id=${toHex(baseEntry.id)} — deferring to pass 2`,
					)
					break
				}
			}
			if (shouldDefer) continue
		}

		if (!action) {
			action = {
				cmd_id,
				id,
				name: `Unknown cmd:${toHex(cmd_id)} id:${toHex(id).toUpperCase()}`,
				options: [valueBytesToOption(valueBytes)],
			}
			if (busCh !== undefined) action.busCh = busCh
			logger.warn(`Could not infer cmd_id=${toHex(cmd_id)} id=${toHex(id)}`)
		} else {
			action.options = action.options?.filter((o) => o.id !== 'busCh') ?? []
			delete action.busCh

			const seenBusChValues = busChSeen.get(`${cmd_id}_${id}`)
			if (seenBusChValues && seenBusChValues.size > 0) {
				const maxBusCh = Math.max(...seenBusChValues)
				if (maxBusCh === 0) {
					action.busCh = 0
				} else {
					const busChChoices = Array.from({ length: maxBusCh + 1 }, (_, i) => ({ id: i, label: `Channel ${i + 1}` }))
					action.options.unshift({ id: 'busCh', label: 'Channel', type: 'dropdown', choices: busChChoices, default: 0 })
				}
			}

			const observedDefault = valueBytesToOption(valueBytes).default
			const valueOpt = action.options?.find((o) => o.id === 'value')
			if (valueOpt) {
				if (valueOpt.choices && Array.isArray(valueOpt.choices)) {
					const inChoices = valueOpt.choices.some((c: any) => c.id === observedDefault)
					if (!inChoices) {
						logger.warn(
							`Inferred choices for cmd_id=${toHex(cmd_id)} id=${toHex(id)} don't contain observed value ${observedDefault} — discarding inherited choices`,
						)
						valueOpt.type = 'number'
						delete (valueOpt as any).choices
					}
				}
				valueOpt.default = observedDefault
			}
		}

		out.cmdSchema.push(action)
	}

	for (const { cmd_id, id } of parsed) {
		const alreadyTopLevel = out.cmdSchema.some((a) => a.cmd_id === cmd_id && a.id === id)
		if (alreadyTopLevel) continue

		const idAddBase = out.cmdSchema.find((a) => {
			if (a.cmd_id !== cmd_id) return false
			const idAddOpt = a.options?.find((o) => o.id === 'idAdd')
			return !!idAddOpt?.choices && id > a.id
		})
		if (!idAddBase) continue

		const offset = id - idAddBase.id
		const idAddOpt = idAddBase.options?.find((o) => o.id === 'idAdd')
		if (!idAddOpt?.choices || idAddOpt.choices.some((c: any) => c.id === offset)) continue

		const refHasOffset = candidates.some((c) => {
			const refEntry = c.cmdSchema?.find((r) => r.cmd_id === cmd_id && r.id === idAddBase.id)
			const refIdAdd = refEntry?.options?.find((o) => o.id === 'idAdd')
			return refIdAdd?.choices?.some((ch: any) => ch.id === offset)
		})
		const existingOffsets = idAddOpt.choices.map((c: any) => c.id as number).sort((a, b) => a - b)
		const isSequential = existingOffsets.length > 0 && offset === existingOffsets[existingOffsets.length - 1] + 1

		if (!refHasOffset && !isSequential) continue

		let label = `Channel ${offset + 1}`
		for (const c of candidates) {
			const refEntry = c.cmdSchema?.find((a) => a.cmd_id === cmd_id && a.id === idAddBase.id)
			const refIdAdd = refEntry?.options?.find((o) => o.id === 'idAdd')
			const refChoice = refIdAdd?.choices?.find((ch: any) => ch.id === offset)
			if (refChoice) {
				label = refChoice.label
				break
			}
		}

		idAddOpt.choices.push({ id: offset, label })
		logger.info(
			`Pass 2: Folded cmd_id=${toHex(cmd_id)} id=${toHex(id)} into idAdd base id=${toHex(idAddBase.id)} as offset ${offset} ("${label}")`,
		)
	}

	return out
}

export function saveModelJsonPretty(filePath: string, jsonObj: StModelJson): void {
	try {
		const orderedObj: any = { model: jsonObj.model }
		if ('useConMon' in jsonObj) orderedObj.useConMon = jsonObj.useConMon
		if ('cmdSchema' in jsonObj) {
			orderedObj.cmdSchema = jsonObj.cmdSchema.map((entry: any) => {
				const orderedEntry: any = {}
				if ('cmd_id' in entry) orderedEntry.cmd_id = entry.cmd_id
				if ('id' in entry) orderedEntry.id = entry.id
				if ('busCh' in entry) orderedEntry.busCh = entry.busCh
				if ('name' in entry) orderedEntry.name = entry.name
				if ('value' in entry) orderedEntry.value = entry.value
				if ('options' in entry) orderedEntry.options = entry.options
				for (const key of Object.keys(entry)) {
					if (!(key in orderedEntry)) orderedEntry[key] = entry[key]
				}
				return orderedEntry
			})
		}
		for (const key of Object.keys(jsonObj)) {
			if (!(key in orderedObj)) orderedObj[key] = (jsonObj as any)[key]
		}

		let json = JSON.stringify(orderedObj, null, 2)
		json = json.replace(/\{\n\s+"id":\s*(\d+),\n\s+"label":\s*"([^"]*)"\n\s+\}/g, '{ "id": $1, "label": "$2" }')
		fs.writeFileSync(filePath, json + '\n', 'utf8')
	} catch (e) {
		logger.error(`File Write Error: ${e}`)
	}
}
