import dgram from 'dgram'
import os from 'os'
import { createModuleLogger } from '@companion-module/base'
import type { DeviceInfo } from './types.js'

const logger = createModuleLogger('Dante')

const DANTE_MSG_INFO_REQUEST = 0x0020
export const DANTE_MSG_INFO_RESPONSE = 0x0170
const DANTE_INFO_MIN_LEN = 0xcc + 64

function buildDanteInfoRequest(): Buffer {
	const buf = Buffer.alloc(32, 0)
	const seq = Math.floor(Math.random() * 0xffff)

	buf.writeUInt16BE(0xffff, 0)
	buf.writeUInt16BE(DANTE_MSG_INFO_REQUEST, 2)
	buf.writeUInt16BE(seq, 4)

	const mac = getFirstLocalMac()
	mac.copy(buf, 8)

	Buffer.from('Audinate', 'ascii').copy(buf, 16)
	buf.writeUInt16BE(0x0739, 24)
	buf.writeUInt16BE(0x00c1, 26)
	buf.writeUInt32BE(0x000f4240, 28)

	return buf
}

function getFirstLocalMac(): Buffer {
	try {
		const ifaces = os.networkInterfaces()
		for (const name of Object.keys(ifaces)) {
			for (const addr of ifaces[name] ?? []) {
				if (!addr.internal && addr.family === 'IPv4' && addr.mac && addr.mac !== '00:00:00:00:00:00') {
					return Buffer.from(addr.mac.split(':').map((h: string) => parseInt(h, 16)))
				}
			}
		}
	} catch {
		/* ignore */
	}
	return Buffer.alloc(6, 0)
}

export function parseDanteInfoResponse(msg: Buffer, srcIp: string): DeviceInfo | null {
	if (msg.length < DANTE_INFO_MIN_LEN) return null
	if (msg.readUInt16BE(0) !== 0xffff) return null
	if (msg.readUInt16BE(2) !== DANTE_MSG_INFO_RESPONSE) return null
	if (msg.subarray(16, 24).toString('ascii') !== 'Audinate') return null

	const readStr = (offset: number, len: number): string =>
		msg
			.subarray(offset, offset + len)
			.toString('ascii')
			.split('\0')[0]
			.trim()

	const eui64 = msg.subarray(8, 16)
	const macBytes = [eui64[0], eui64[1], eui64[2], eui64[5], eui64[6], eui64[7]]
	const mac = macBytes.map((b) => b.toString(16).padStart(2, '0')).join(':')

	const name = readStr(0x20, 31)
	const manufacturer = readStr(0x4c, 64)
	const modelRaw = readStr(0xcc, 64)
	const danteFirmware = `${msg[0x18]}.${msg[0x19]}`

	if (!modelRaw) return null

	const model = modelRaw
		.replace(/^Model\s+/i, '')
		.trim()
		.split(/\s+/)[0]

	return {
		ip: srcIp,
		name,
		manufacturer,
		model,
		modelName: modelRaw, // Full model description
		mac,
		danteFirmware,
	}
}

export async function getMacForDestination(destIp: string): Promise<number[]> {
	return new Promise<number[]>((resolve, reject) => {
		const tmp = dgram.createSocket('udp4')

		tmp.once('error', (err) => {
			tmp.close()
			reject(new Error(err.message ?? String(err)))
		})

		tmp.connect(9, destIp, () => {
			try {
				const addr = tmp.address() as { address: string }
				const localAddr = addr.address
				tmp.close()

				const ifaces = os.networkInterfaces()
				for (const name of Object.keys(ifaces)) {
					for (const iface of ifaces[name] ?? []) {
						if (
							iface.family === 'IPv4' &&
							iface.address === localAddr &&
							iface.mac &&
							iface.mac !== '00:00:00:00:00:00'
						) {
							return resolve(iface.mac.split(':').map((b) => parseInt(b, 16) & 0xff))
						}
					}
				}
				reject(new Error(`No interface found for local address ${localAddr}`))
			} catch (_e) {
				reject(new Error(String(_e)))
			}
		})
	})
}

export async function getLocalAddressForDestination(destIp: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const tmp = dgram.createSocket('udp4')

		let resolved = false
		tmp.once('error', (err) => {
			if (!resolved) {
				resolved = true
				tmp.close()
				reject(new Error(err.message ?? String(err)))
			}
		})

		tmp.connect(9, destIp, () => {
			try {
				const addr = tmp.address() as { address: string }
				const localAddr = addr.address
				if (!resolved) {
					resolved = true
					tmp.close()
					resolve(localAddr)
				}
			} catch (_e) {
				if (!resolved) {
					resolved = true
					tmp.close()
					reject(new Error(String(_e)))
				}
			}
		})
	})
}

export async function discoverDevices(
	txSocket: dgram.Socket,
	ensureMembership: (destIp: string) => Promise<void>,
	timeoutMs = 5000,
): Promise<void> {
	const DANTE_ANNOUNCE_GROUP = '224.0.0.233'
	const DANTE_ANNOUNCE_PORT = 8708
	const DEFAULT_PORT = 8700

	const queriedIps = new Set<string>()

	return new Promise<void>((resolve) => {
		const announceSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
		const joinedInterfaces: string[] = []

		const cleanup = () => {
			for (const iface of joinedInterfaces) {
				try {
					announceSocket.dropMembership(DANTE_ANNOUNCE_GROUP, iface)
				} catch {
					/* ignore */
				}
			}
			try {
				announceSocket.close()
			} catch {
				/* ignore */
			}
			resolve()
		}

		const timer = setTimeout(cleanup, timeoutMs)
		timer.unref?.()

		announceSocket.on('error', (err) => {
			logger.warn(`Announce socket error: ${err.message}`)
		})

		announceSocket.on('message', (msg, rinfo) => {
			const srcIp = rinfo.address
			if (msg.length < 24) return
			if (msg.readUInt16BE(0) !== 0xfffe) return
			if (msg.subarray(16, 24).toString('ascii') !== 'Audinate') return

			if (queriedIps.has(srcIp)) return
			queriedIps.add(srcIp)
			logger.debug(`Announce from ${srcIp} — sending unicast query`)

			const sendQuery = async () => {
				await ensureMembership(srcIp)
				const query = buildDanteInfoRequest()
				txSocket.send(query, DEFAULT_PORT, srcIp, (err) => {
					if (err) logger.warn(`Unicast query to ${srcIp} failed: ${err.message}`)
				})
			}
			sendQuery().catch((err) => logger.warn(`Query setup failed: ${err}`))
		})

		announceSocket.bind(DANTE_ANNOUNCE_PORT, () => {
			const ifaces = os.networkInterfaces()
			for (const addrs of Object.values(ifaces)) {
				for (const addr of addrs ?? []) {
					if (addr.family === 'IPv4' && !addr.internal) {
						try {
							announceSocket.addMembership(DANTE_ANNOUNCE_GROUP, addr.address)
							joinedInterfaces.push(addr.address)
						} catch {
							/* ignore — interface may not support multicast */
						}
					}
				}
			}
			if (joinedInterfaces.length === 0) {
				logger.warn(`Could not join announce multicast group on any interface`)
			} else {
				logger.debug(`Listening for Dante announces on ${DANTE_ANNOUNCE_GROUP}:${DANTE_ANNOUNCE_PORT}`)
			}
		})
	})
}

export async function probeDevice(
	txSocket: dgram.Socket,
	registerListener: (key: string, cb: (device: DeviceInfo) => void) => void,
	removeListener: (key: string) => void,
	ensureMembership: (ip: string) => Promise<void>,
	ip: string,
	timeoutMs = 3000,
): Promise<DeviceInfo | null> {
	return new Promise<DeviceInfo | null>((resolve) => {
		const key = `__probe_${ip}__`
		let resolved = false

		const finish = (result: DeviceInfo | null) => {
			if (resolved) return
			resolved = true
			removeListener(key)
			resolve(result)
		}

		registerListener(key, (device: DeviceInfo) => {
			if (device.ip === ip) finish(device)
		})

		const timer = setTimeout(() => finish(null), timeoutMs)
		timer.unref?.()

		const run = async () => {
			await ensureMembership(ip)
			const query = buildDanteInfoRequest()
			txSocket.send(query, 8700, ip, (err) => {
				if (err) {
					logger.warn(`Probe to ${ip} failed: ${err.message}`)
					clearTimeout(timer)
					finish(null)
				}
			})
		}

		run().catch((e) => {
			logger.warn(`probeDevice setup failed for ${ip}: ${e}`)
			clearTimeout(timer)
			finish(null)
		})
	})
}
