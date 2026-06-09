import dgram from 'dgram'
import os from 'os'
import { createModuleLogger } from '@companion-module/base'
import {
	CMD_BUS_GET,
	CMD_BUS_SET,
	CMD_DEV_SPEC,
	CMD_GET_ALL_SETTINGS,
	CMD_GET_FIRMWARE,
	CMD_GLOBAL_MIC_KILL,
	CMD_MIC_PRE,
	CMD_MIC_PRE_BUS,
	CMD_RESET_DEVICE,
	CMD_SETTINGS_PUSH,
	getCommandName,
	makeSettingId,
	toHex,
	bytesToHex,
	type DeviceInfo,
} from './types.js'
import {
	parseGetAllSettingsForModel,
	parseSettingsResponse,
	formatParsedSetting,
	type StAction,
	type ParsedSetting,
} from './settingsParser.js'
import { getDeviceSchema } from './config.js'

import {
	DANTE_MSG_INFO_RESPONSE,
	parseDanteInfoResponse,
	discoverDevices,
	probeDevice as danteProbeDevice,
	getMacForDestination,
	getLocalAddressForDestination,
} from './dante.js'
import { openConMonSession } from './conmon.js'

const logger = createModuleLogger('StController')

export class StController {
	private readonly defaultPort: number = 8700
	private readonly multicastGroup = '224.0.0.231'
	private readonly rxPort = 8702

	private txSocket: dgram.Socket
	private rxSocket: dgram.Socket
	private rxMcastSocket: dgram.Socket | null = null
	private mcastDeliveries: Set<string> = new Set()
	private pendingAcks: Map<
		string,
		{ resolve: (buf: Buffer) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
	> = new Map()
	private joinedInterfaces: Set<string> = new Set()

	private sendQueue: Promise<void> = Promise.resolve()
	private pendingCommandCount = 0
	private txReady: Promise<void>
	private model: string = ''
	private actions: StAction[] = []
	private deviceState: Map<string, Map<string, number>> = new Map()
	private authorizedIps: Set<string> = new Set()
	private discoveryListeners: Map<string, (device: DeviceInfo) => void> = new Map()
	private feedbackCallback?: (feedbackId: string) => void
	private macCache: Map<string, number[]> = new Map()
	private sessionEstablished: Set<string> = new Set()
	private _conmonCleanups: Map<string, () => void> = new Map()

	constructor() {
		logger.info('StController initialized')

		this.txSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
		this.txReady = new Promise<void>((resolve) => {
			this.txSocket.bind(0, () => {
				logger.debug(`TX socket bound to port ${(this.txSocket.address() as { port: number }).port}`)
				resolve()
			})
		})
		this.txSocket.on('error', (err) => {
			logger.error(`TX socket error: ${err}`)
		})

		this.rxSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true })

		this.rxSocket.on('listening', () => {
			const addr = this.rxSocket.address()
			logger.debug(`RX socket listening on ${JSON.stringify(addr)}`)
			try {
				this.rxSocket.setMulticastLoopback(true)
			} catch (_e) {
				/* ignore */
			}
		})

		this.rxSocket.on('error', (err) => {
			logger.error(`RX socket error: ${err}`)
		})

		this.rxSocket.on('message', (msg, rinfo) => {
			try {
				this.handleIncoming(msg, rinfo.address)
			} catch (_e) {
				logger.error(`Error handling incoming message: ${_e}`)
			}
		})

		this.rxSocket.bind({ address: '0.0.0.0', port: this.rxPort }, () => {
			logger.debug(`RX socket bound to 0.0.0.0:${this.rxPort}`)
			const ifaces = os.networkInterfaces() as Record<string, import('os').NetworkInterfaceInfo[]>
			for (const addrs of Object.values(ifaces)) {
				for (const addr of addrs ?? []) {
					if (addr.family === 'IPv4' && !addr.internal && !this.joinedInterfaces.has(addr.address)) {
						try {
							this.rxSocket.addMembership(this.multicastGroup, addr.address)
							this.joinedInterfaces.add(addr.address)
							logger.debug(`Pre-joined multicast ${this.multicastGroup} on ${addr.address}`)
						} catch (_e) {
							logger.warn(`Could not pre-join multicast on ${addr.address}: ${String(_e)}`)
						}
					}
				}
			}
		})

		this.rxMcastSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
		this.rxMcastSocket.on('error', (err) => {
			logger.debug(`RX mcast socket error: ${err.message}`)
		})
		this.rxMcastSocket.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
			if (msg.length < 25) return
			if (msg[0] !== 0xff || msg[1] !== 0xff) return
			const sig = msg.subarray(16, 24)
			if (sig.toString('ascii') !== 'Studio-T') return
			const stPayload = msg.subarray(24)
			if (stPayload.length < 2 || stPayload[0] !== 0x5a) return
			const respCmdId = stPayload[1]
			const isResponse = (respCmdId & 0x80) !== 0
			const originalCmdId = respCmdId & 0x7f
			if (isResponse) {
				const key = `${rinfo.address}:${originalCmdId}`
				const wasUnicastAlready = !this.mcastDeliveries.has(key)
				this.mcastDeliveries.add(key)
				logger.debug(
					`Multicast delivery: ${rinfo.address} cmd:${toHex(originalCmdId)}` +
						(wasUnicastAlready ? ' (unicast also pending)' : ' (multicast only so far)'),
				)
				setTimeout(() => this.mcastDeliveries.delete(key), 500)
			}
		})
		this.rxMcastSocket.bind({ address: this.multicastGroup, port: this.rxPort }, () => {
			logger.debug(`RX mcast socket bound to ${this.multicastGroup}:${this.rxPort}`)
		})
	}

	public close(): void {
		// Stop all ConMon keepalives and close their sockets before closing the main sockets
		for (const cleanup of this._conmonCleanups.values()) {
			try {
				cleanup()
			} catch {
				/* ignore */
			}
		}
		this._conmonCleanups.clear()
		try {
			for (const localAddr of Array.from(this.joinedInterfaces)) {
				try {
					this.rxSocket.dropMembership(this.multicastGroup, localAddr)
				} catch {
					/* ignore */
				}
			}
		} catch {
			/* ignore */
		}
		try {
			this.rxMcastSocket?.close()
			this.rxMcastSocket = null
		} catch {
			/* ignore */
		}
		try {
			this.rxSocket.close()
		} catch {
			/* ignore */
		}
		try {
			this.txSocket.close()
		} catch {
			/* ignore */
		}
	}

	public setModel(model: string, actions: StAction[]): void {
		this.model = model
		this.actions = actions
	}

	public setFeedbackCallback(callback: (feedbackId: string) => void): void {
		this.feedbackCallback = callback
	}

	public isDeviceAuthorized(ip: string): boolean {
		return this.authorizedIps.has(ip)
	}

	public authorizeDevice(ip: string): void {
		this.authorizedIps.add(ip)
		logger.debug(`Authorized device at ${ip}`)
	}

	public revokeDevice(ip: string): void {
		this.authorizedIps.delete(ip)
		this.deviceState.delete(ip)
		this.macCache.delete(ip)
		this.sessionEstablished.delete(ip)
		this._conmonCleanups.get(ip)?.()
		this._conmonCleanups.delete(ip)
		logger.debug(`Revoked device at ${ip}`)
	}

	public async openSession(deviceIp: string): Promise<boolean> {
		if (this.sessionEstablished.has(deviceIp)) return true
		const schema = getDeviceSchema(this.model)
		if (!schema?.useConMon) {
			this.sessionEstablished.add(deviceIp)
			return true
		}
		const cleanup = await openConMonSession(deviceIp)
		const success = cleanup !== null
		this.sessionEstablished.add(deviceIp)
		if (success) {
			this._conmonCleanups.set(deviceIp, cleanup)
		}
		return success
	}

	public async probeDevice(ip: string, timeoutMs = 3000): Promise<DeviceInfo | null> {
		await this.txReady
		return danteProbeDevice(
			this.txSocket,
			(key, cb) => this.discoveryListeners.set(key, cb),
			(key) => this.discoveryListeners.delete(key),
			async (destIp) => this.ensureMembershipFor(destIp),
			ip,
			timeoutMs,
		)
	}

	public async requestAllSettings(deviceIp: string): Promise<Buffer> {
		logger.info(`Requesting all settings from ${deviceIp}`)
		const response = await this.sendAwaitAck(CMD_GET_ALL_SETTINGS, undefined, undefined, undefined, deviceIp, false)
		return response
	}

	public async discoverDevices(timeoutMs = 5000): Promise<DeviceInfo[]> {
		const DISCOVERY_KEY = '__discovery__'
		const foundDevices: DeviceInfo[] = []

		this.discoveryListeners.set(DISCOVERY_KEY, (device: DeviceInfo) => {
			if (!foundDevices.some((d) => d.ip === device.ip)) {
				foundDevices.push(device)
			}
		})

		try {
			await this.txReady
			await discoverDevices(this.txSocket, async (destIp) => this.ensureMembershipFor(destIp), timeoutMs)
			return foundDevices
		} finally {
			this.discoveryListeners.delete(DISCOVERY_KEY)
		}
	}

	public async requestFirmwareVersion(deviceIp: string): Promise<string> {
		logger.info(`Requesting firmware version from ${deviceIp}`)
		const response = await this.sendAwaitAck(CMD_GET_FIRMWARE, undefined, undefined, undefined, deviceIp, false)

		const dataStart = 26

		if (response.length < dataStart + 3) {
			logger.warn(`Firmware response too short: ${response.length} bytes`)
			return 'Unknown'
		}

		const major = response[dataStart + 1]
		const minor = response[dataStart + 2]

		const minorStr = minor < 10 ? minor.toString().padStart(2, '0') : minor.toString()
		const firmware = `${major}.${minorStr}`

		logger.debug(`Firmware version: ${firmware}`)
		return firmware
	}

	/**
	 * Joins the multicast response group on the interface that routes to destIp.
	 * Only joins the specific interface used to reach the device, and only once per interface.
	 */
	private async ensureMembershipFor(destIp: string): Promise<void> {
		try {
			const localAddr = await getLocalAddressForDestination(destIp)
			if (!localAddr) {
				logger.warn(`Could not determine local address for destination ${destIp}`)
				return
			}

			if (this.joinedInterfaces.has(localAddr)) {
				// already joined
				return
			}

			try {
				this.rxSocket.addMembership(this.multicastGroup, localAddr)
				this.joinedInterfaces.add(localAddr)
				logger.info(`Joined multicast ${this.multicastGroup} on ${localAddr}`)
			} catch (_e) {
				logger.warn(`Failed to join multicast on ${localAddr}: ${String(_e)}`)
			}
		} catch (_e) {
			logger.warn(`ensureMembershipFor failed: ${_e}`)
		}
	}

	public async sendAwaitAck(
		cmdId: number,
		busCh: number | undefined,
		settingId: number | undefined,
		value: unknown,
		destIp: string,
		addLen = true,
	): Promise<Buffer> {
		this.pendingCommandCount++
		return new Promise<Buffer>((resolve, reject) => {
			this.sendQueue = this.sendQueue.then(async () =>
				this._sendAwaitAck(cmdId, busCh, settingId, value, destIp, addLen)
					.then((buf) => {
						this.pendingCommandCount--
						if (this.pendingCommandCount === 0 && value !== undefined) {
							this.requestAllSettings(destIp).catch((err) => {
								logger.warn(`Failed to refresh settings after command: ${err}`)
							})
						}
						resolve(buf)
					})
					.catch((err) => {
						this.pendingCommandCount--
						reject(err instanceof Error ? err : new Error(String(err)))
					}),
			)
		})
	}

	private async _sendAwaitAck(
		cmdId: number,
		busCh: number | undefined,
		settingId: number | undefined,
		value: unknown,
		destIp: string,
		addLen = true,
	): Promise<Buffer> {
		const timeoutMs = 2000

		const dataBlock: number[] = []
		if (settingId !== undefined) dataBlock.push(settingId & 0xff)
		if (value !== undefined) dataBlock.push(...StController.buildValueBytes(value))

		const payloadBody: number[] = [0x5a, cmdId & 0xff]

		if (cmdId === CMD_MIC_PRE && busCh !== undefined && settingId !== undefined && value !== undefined) {
			if (!this.deviceState.has(destIp)) this.deviceState.set(destIp, new Map())
			const ipState = this.deviceState.get(destIp)!
			const numPositions = 3
			const positions: number[] = []
			for (let i = 0; i < numPositions; i++) {
				const stateKey = makeSettingId(this.model, CMD_MIC_PRE, i, busCh)
				const val = i === settingId ? Number(value) : (ipState.get(stateKey) ?? 0)
				positions.push(val)
				ipState.set(stateKey, val)
			}
			payloadBody.push(busCh & 0xff, ...positions)
		} else {
			if (busCh !== undefined) payloadBody.push(busCh & 0xff)
			if (addLen) payloadBody.push(dataBlock.length)
			if (dataBlock.length > 0) payloadBody.push(...dataBlock)
		}

		const crc = StController.crc8DvbS2(payloadBody)
		const payloadWithCrc = Buffer.from([...payloadBody, crc])

		// Human-readable info log for the outgoing command
		if (settingId !== undefined && value !== undefined) {
			const valueBytes = StController.buildValueBytes(value)
			const setting: ParsedSetting = {
				cmd_id: cmdId,
				id: settingId,
				busCh,
				valueBytes,
			}
			logger.info(`TX ${destIp} | ${formatParsedSetting(setting, this.actions)}`)
		} else {
			logger.info(`TX ${destIp} | ${getCommandName(cmdId)}`)
		}

		if (!this.authorizedIps.has(destIp)) {
			logger.debug(`Packet (not sent — device not authorized) to ${destIp}: ${payloadWithCrc.toString('hex')}`)
			throw new Error(`Device at ${destIp} is not authorized — verify the IP and model match before sending commands`)
		}

		if (!this.sessionEstablished.has(destIp)) {
			await this.openSession(destIp)
		}

		// Ensure we are listening for replies on the interface that will receive them
		await this.ensureMembershipFor(destIp)

		const totalLen = 24 + payloadWithCrc.length
		const header = await this.buildHeader(totalLen, destIp)
		const packet = Buffer.concat([header, payloadWithCrc])

		logger.debug(`Sending packet to ${destIp}: ${packet.toString('hex')}`)

		const key = `${destIp}:${cmdId}`

		return new Promise<Buffer>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingAcks.delete(key)
				reject(new Error(`Timeout waiting for ACK from Model ${this.model} at ${destIp}:8700`))
			}, timeoutMs)

			this.pendingAcks.set(key, {
				resolve: (buf) => {
					clearTimeout(timer)
					resolve(buf)
				},
				reject: (err) => {
					clearTimeout(timer)
					reject(err)
				},
				timer,
			})

			this.txSocket.send(packet, this.defaultPort, destIp, (err) => {
				if (err) {
					this.pendingAcks.delete(key)
					clearTimeout(timer)
					reject(new Error(err.message ?? String(err)))
				}
			})
		})
	}

	private handleIncoming(msg: Buffer, srcIp: string) {
		if (msg.length < 4) return
		if (msg[0] !== 0xff || msg[1] !== 0xff) return

		const msgType = msg.readUInt16BE(2)

		if (msgType === DANTE_MSG_INFO_RESPONSE && this.discoveryListeners.size > 0) {
			const device = parseDanteInfoResponse(msg, srcIp)
			if (device) {
				logger.debug(
					`Dante info response from ${srcIp}: ` +
						`DeviceID="${device.name}", ` +
						`Model="${device.model}", ` +
						`ModelName="${device.modelName}", ` +
						`Manufacturer="${device.manufacturer}"`,
				)
				if (device.name === 'Studio-T') {
					for (const cb of this.discoveryListeners.values()) {
						try {
							cb(device)
						} catch {
							/* ignore */
						}
					}
				} else {
					logger.debug(`Ignoring non-Studio Technologies device: DeviceID="${device.name}" @ ${srcIp}`)
				}
			}
			return
		}

		if (msg.length < 25) return

		// ── Studio-T control protocol ─────────────────────────────────────────
		const sig = msg.subarray(16, 24)
		if (sig.toString('ascii') !== 'Studio-T') return

		if (!this.authorizedIps.has(srcIp)) {
			logger.debug(`Ignoring Studio-T packet from unauthorized device ${srcIp}`)
			return
		}

		const stPayload = msg.subarray(24)
		if (stPayload.length < 2) return
		if (stPayload[0] !== 0x5a) return

		const respCmdId = stPayload[1]
		const isResponse = (respCmdId & 0x80) !== 0
		const originalCmdId = respCmdId & 0x7f

		if (isResponse) {
			const key = `${srcIp}:${originalCmdId}`
			const pending = this.pendingAcks.get(key)
			if (pending) {
				this.pendingAcks.delete(key)
				const viaMulticast = this.mcastDeliveries.has(key)
				logger.debug(
					`RX delivery method: ${srcIp} cmd:${toHex(originalCmdId)} via ${viaMulticast ? 'multicast' : 'unicast'}`,
				)
				if (originalCmdId === CMD_GET_ALL_SETTINGS) {
					logger.debug(`Received packet from ${srcIp}: ${msg.toString('hex')}`)
				}
				this.logStPayload(srcIp, originalCmdId, msg, stPayload)
				pending.resolve(msg)
			} else if (originalCmdId === CMD_SETTINGS_PUSH) {
				this.logStPayload(srcIp, originalCmdId, msg, stPayload)
			}
		} else {
			const data = stPayload.subarray(2, stPayload.length - 1)
			const hasSchemaEntries = this.actions.some((a) => a.cmd_id === originalCmdId)
			if (hasSchemaEntries && data.length >= 2) {
				const dataLen = data[0]
				const payload = data.subarray(1)
				if (payload.length >= dataLen && dataLen > 0) {
					const parsed: ParsedSetting[] = []
					let q = 0
					while (q + 1 < dataLen) {
						const id = payload[q]
						const valueBytes = [payload[q + 1]]
						parsed.push({ cmd_id: originalCmdId, id, valueBytes })
						q += 2
					}
					if (parsed.length > 0) {
						this.applyParsedSettings(srcIp, parsed)
						return
					}
				}
			}
			this.logStPayload(srcIp, originalCmdId, msg, stPayload)
		}
	}

	private applyParsedSettings(srcIp: string, settings: ParsedSetting[]): void {
		const state = this.deviceState.get(srcIp) ?? new Map<string, number>()
		if (!this.deviceState.has(srcIp)) this.deviceState.set(srcIp, state)

		for (const s of settings) {
			const stateKey = makeSettingId(this.model, s.cmd_id, s.id, s.busCh)
			const newValue =
				s.valueBytes.length === 3
					? (s.valueBytes[0] << 16) | (s.valueBytes[1] << 8) | s.valueBytes[2]
					: (s.valueBytes[0] ?? 0)
			const prevValue = state.get(stateKey)
			const changed = prevValue === undefined || prevValue !== newValue

			state.set(stateKey, newValue)

			const formatted = formatParsedSetting(s, this.actions)
			if (changed) {
				logger.info(`RX ${srcIp} | ${formatted}`)
				if (this.feedbackCallback) {
					let baseId = s.id
					const baseAction = this.actions.find((a) => {
						if (a.cmd_id !== s.cmd_id) return false
						if (a.id === s.id) return true
						const idAddOption = a.options?.find((o) => o.id === 'idAdd')
						if (!idAddOption?.choices) return false
						const offset = s.id - a.id
						return offset > 0 && idAddOption.choices.some((c) => c.id === offset)
					})
					if (baseAction) baseId = baseAction.id
					const baseFeedbackKey = makeSettingId(this.model, s.cmd_id, baseId)
					this.feedbackCallback(baseFeedbackKey)
					this.feedbackCallback(baseFeedbackKey + '_bool')
				} else {
					logger.warn(`feedbackCallback not set — skipping feedback update for ${stateKey}`)
				}
			} else {
				logger.debug(`RX ${srcIp} | ${formatted}`)
			}
		}
	}

	private logStPayload(srcIp: string, cmdId: number, msg: Buffer, stPayload: Buffer): void {
		const cmdName = getCommandName(cmdId)
		const data = stPayload.subarray(2, stPayload.length - 1)
		const respCmdId = stPayload[1]
		const crc = stPayload[stPayload.length - 1]
		const fullStructure = `[cmd:${toHex(respCmdId)} data:${data.toString('hex')} crc:${toHex(crc)}]`

		if (cmdId === CMD_GET_ALL_SETTINGS || cmdId === CMD_SETTINGS_PUSH) {
			if (!this.model) {
				logger.info(`RX ${srcIp} | ${cmdName} | ${fullStructure}`)
				return
			}
			try {
				const settings =
					cmdId === CMD_SETTINGS_PUSH
						? parseSettingsResponse(this.model, msg)
						: parseGetAllSettingsForModel(this.model, msg)
				this.applyParsedSettings(srcIp, settings)
			} catch (e) {
				logger.warn(`RX ${srcIp} | ${cmdName} | parse failed: ${e} | ${fullStructure}`)
			}
			return
		}

		const decoded = this.decodeStData(cmdId, data)
		const logFn = cmdId === CMD_BUS_GET ? logger.debug.bind(logger) : logger.info.bind(logger)
		if (decoded) {
			logFn(`RX ${srcIp} | ${cmdName} | ${fullStructure} | ${decoded}`)
		} else {
			logFn(`RX ${srcIp} | ${cmdName} | ${fullStructure}`)
		}
	}

	private decodeStData(cmdId: number, data: Buffer): string | null {
		if (data.length === 0) return 'ACK'
		if (data.length === 1) {
			if (data[0] === 0x00) return 'ACK ok'
			return `ERROR ${toHex(data[0])}`
		}

		switch (cmdId) {
			case CMD_MIC_PRE: {
				const busCh = data[0]
				const vals = Array.from(data.subarray(1))
					.map((b, i) => `[${i}]=0x${b.toString(16).padStart(2, '0')}(${b})`)
					.join(' ')
				return `ch=${busCh} ${vals}`
			}

			case CMD_DEV_SPEC: {
				if (data.length === 1) {
					return data[0] === 0x00 ? 'ACK ok' : `ACK err=${toHex(data[0])}`
				}
				if (data.length >= 3) {
					const busCh = data[0]
					const settingId = data[1]
					const valueBytes = data.subarray(2)
					const action = this.actions.find((a) => a.cmd_id === cmdId && a.id === settingId)
					const settingName = action?.name ?? `setting=${toHex(settingId)}`
					const choices = action?.options?.find((o) => o.id === 'value')?.choices
					const valueNum = valueBytes.length === 1 ? valueBytes[0] : undefined
					const choiceLabel =
						choices && valueNum !== undefined ? choices.find((c) => c.id === valueNum)?.label : undefined
					const valueStr = choiceLabel ? `${choiceLabel} (${toHex(valueNum!)})` : bytesToHex(Array.from(valueBytes))
					const rawTag = `[${toHex(cmdId)}/${toHex(settingId)}]=${bytesToHex(Array.from(valueBytes))}`
					return `echo ch=${busCh} | ${settingName}: ${valueStr} ${rawTag}`
				}
				return `raw: ${data.toString('hex')}`
			}

			case CMD_MIC_PRE_BUS: {
				if (data.length >= 3) {
					const busCh = data[0]
					const settingId = data[1]
					const valueBytes = data.subarray(2)
					const action = this.actions.find((a) => a.cmd_id === cmdId && a.id === settingId)
					const settingName = action?.name ?? `setting=${toHex(settingId)}`
					const valueNum = valueBytes.length === 1 ? valueBytes[0] : undefined
					const choices = action?.options?.find((o) => o.id === 'value')?.choices
					const choiceLabel =
						choices && valueNum !== undefined ? choices.find((c) => c.id === valueNum)?.label : undefined
					const valueStr = choiceLabel ?? `0x${valueBytes.toString('hex')}`
					return `echo ch=${busCh} | ${settingName}: ${valueStr}`
				}
				return null
			}

			case CMD_BUS_GET:
			case CMD_BUS_SET: {
				if (data.length < 2) return null
				const busCh = data[0]
				const settingId = data[1]
				const value = data.subarray(2)
				return `ch=${busCh} setting=${toHex(settingId)} value=${value.toString('hex')}`
			}

			default:
				return null
		}
	}

	private static buildValueBytes(value: unknown): number[] {
		if (typeof value === 'boolean') return [value ? 1 : 0]
		if (Array.isArray(value)) return value.map((v) => Number(v) & 0xff)
		if (typeof value === 'number') {
			if (value > 0xff) return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
			return [value & 0xff]
		}
		throw new Error(`Unsupported value type for STcontroller: ${value}`)
	}

	private async buildHeader(totalLen: number, destIp: string): Promise<Buffer> {
		let mac = this.macCache.get(destIp)
		if (!mac) {
			mac = await getMacForDestination(destIp)
			this.macCache.set(destIp, mac)
		}

		return Buffer.concat([
			Buffer.from([0xff, 0xff, 0x00, totalLen & 0xff, 0x07, 0xe1, 0x00, 0x00, ...mac, 0x00, 0x00]),
			Buffer.from('Studio-T', 'utf8'),
		])
	}

	private static crc8DvbS2(data: number[]): number {
		let crc = 0
		for (const b of data) {
			crc ^= b
			for (let i = 0; i < 8; i++) {
				crc = (crc & 0x80) !== 0 ? ((crc << 1) ^ 0xd5) & 0xff : (crc << 1) & 0xff
			}
		}
		return crc
	}

	public getSettingValue(ip: string, cmdId: number, settingId: number, busCh?: number): number | undefined {
		const key = makeSettingId(this.model, cmdId, settingId, busCh)
		return this.deviceState.get(ip)?.get(key)
	}

	public async resetDevice(destIp: string): Promise<Buffer> {
		return this.sendAwaitAck(CMD_RESET_DEVICE, undefined, 0x00, undefined, destIp, false)
	}

	public async globalMicKill(destIp: string): Promise<Buffer> {
		return this.sendAwaitAck(CMD_GLOBAL_MIC_KILL, undefined, undefined, undefined, destIp, false)
	}
}
