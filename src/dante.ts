import dgram from 'dgram'
import os from 'os'
import { createModuleLogger } from '@companion-module/base'
import type { DeviceInfo } from './types.js'

const logger = createModuleLogger('Dante')

// ─── Dante discovery constants ────────────────────────────────────────────────

/** Dante device info request message type (sent to port 8700) */
export const DANTE_MSG_INFO_REQUEST = 0x0020
/** Dante device info response message type (received on port 8702) */
export const DANTE_MSG_INFO_RESPONSE = 0x0170
export const DANTE_INFO_MIN_LEN = 0xcc + 64 // 268 bytes — need full model field

export function buildDanteInfoRequest(): Buffer {
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

/** Returns the first non-loopback MAC as a 6-byte Buffer, or zeros. */
export function getFirstLocalMac(): Buffer {
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

	const name = readStr(0x20, 31) // Dante device label (can be up to 31 chars per Dante spec)
	const manufacturer = readStr(0x4c, 64) // e.g. "Studio Technologies, Inc."
	const modelRaw = readStr(0xcc, 64)
	const danteFirmware = `${msg[0x18]}.${msg[0x19]}`

	if (!modelRaw) return null

	// Extract just the model number/code (e.g. "Model 391 Alerting Unit" → "391")
	// Strip "Model " prefix, then take only the first word (the model number)
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

/**
 * Returns the MAC address bytes of the local interface used to route to destIp.
 * Uses a temporary UDP connect to let the OS select the outgoing interface,
 * then finds the matching MAC from os.networkInterfaces().
 */
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

/**
 * Returns the local IP address used by the OS to route to destIp.
 * Uses a temporary UDP socket connect to let the OS select the outgoing interface.
 */
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

		// Use an arbitrary port for connect; we only need the kernel to assign a local address.
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

/**
 * Listens for Dante device announces on the local network and sends unicast
 * info requests to each discovered IP. Responses arrive on the caller's rxSocket
 * via handleIncoming() → discoveryListeners.
 *
 * @param txSocket - The socket to use for sending discovery requests
 * @param ensureMembership - Callback to ensure multicast membership before querying
 * @param timeoutMs - How long to listen for announces before resolving
 */
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
			// Validate it's a Dante announce (magic 0xfffe + "Audinate" at offset 16)
			if (msg.length < 24) return
			if (msg.readUInt16BE(0) !== 0xfffe) return
			if (msg.subarray(16, 24).toString('ascii') !== 'Audinate') return

			if (queriedIps.has(srcIp)) return
			queriedIps.add(srcIp)
			logger.debug(`Announce from ${srcIp} — sending unicast query`)

			// Join 224.0.0.231 on the interface that routes to this device BEFORE sending
			// the query. The device multicasts its 0x0170 response to 224.0.0.231:8702
			// in addition to unicasting it — rxSocket must be a member to receive it.
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
			// Join 224.0.0.233 on every non-loopback IPv4 interface so that announces
			// are received regardless of which interface the device is on.
			// On Windows with multiple interfaces (e.g. Hyper-V + LAN), the OS default
			// multicast interface may not be the one connected to the Dante network.
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
				logger.info(`Listening for Dante announces on ${DANTE_ANNOUNCE_GROUP}:${DANTE_ANNOUNCE_PORT}`)
			}
		})
	})
}

// ─── ConMon session (port 8800) ───────────────────────────────────────────────

/** Coalesces concurrent openConMonSession calls per IP */
const _conmonPending = new Map<string, Promise<boolean>>()

/**
 * Opens a Dante ConMon (Control & Monitoring) session with the device on port 8800.
 * Coalesces concurrent calls for the same IP — only one handshake runs at a time.
 *
 * Observed 2-packet handshake (source: jsharkey/wycliffe pcap):
 *   Client → Device  20 bytes: 12 00 00 14 [seq BE] 10 01 00 00 00 00 [MAC 6B] 00 00
 *   Device → Client  32 bytes: 12 00 00 20 ...
 */
export async function openConMonSession(deviceIp: string, timeoutMs = 3000): Promise<boolean> {
	const pending = _conmonPending.get(deviceIp)
	if (pending) return pending

	const promise = _doConMonSession(deviceIp, timeoutMs).finally(() => {
		_conmonPending.delete(deviceIp)
	})
	_conmonPending.set(deviceIp, promise)
	return promise
}

async function _doConMonSession(deviceIp: string, timeoutMs: number): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		let settled = false

		const cleanup = (success: boolean) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			try {
				sock.close()
			} catch {
				/* ignore */
			}
			if (success) {
				logger.info(`ConMon session established with ${deviceIp}`)
			} else {
				logger.debug(`ConMon session not established for ${deviceIp} — device may not require it`)
			}
			resolve(success)
		}

		const timer = setTimeout(() => cleanup(false), timeoutMs)
		const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })

		sock.on('error', (err) => {
			logger.warn(`ConMon socket error for ${deviceIp}: ${err.message}`)
			cleanup(false)
		})

		sock.on('message', (msg: Buffer) => {
			// Device ACK: 12 00 00 20 ... (32 bytes, length field = 0x20)
			if (msg.length >= 4 && msg[0] === 0x12 && msg[3] === 0x20) {
				cleanup(true)
			}
		})

		const doInit = async () => {
			let localIp: string
			let localMac: number[]
			try {
				localIp = await getLocalAddressForDestination(deviceIp)
				localMac = await getMacForDestination(deviceIp)
			} catch (e) {
				logger.warn(`ConMon: could not get local network info for ${deviceIp}: ${e}`)
				cleanup(false)
				return
			}

			sock.bind({ port: 0, address: localIp }, () => {
				const seq = Math.floor(Math.random() * 0xfffe) + 1
				// 20-byte connect packet: 12 00 00 14 [seq] 10 01 00 00 00 00 [MAC 6B] 00 00
				const pkt = Buffer.alloc(20, 0)
				pkt[0] = 0x12
				pkt[3] = 0x14 // total length = 20
				pkt.writeUInt16BE(seq, 4)
				pkt[6] = 0x10
				pkt[7] = 0x01
				// bytes 8-11 = zeros; bytes 12-17 = client MAC (6 bytes); bytes 18-19 = zeros
				localMac.forEach((b, i) => {
					pkt[12 + i] = b
				})
				logger.debug(`ConMon TX to ${deviceIp}: ${pkt.toString('hex')}`)
				sock.send(pkt, 8800, deviceIp, (err) => {
					if (err) {
						logger.warn(`ConMon send failed for ${deviceIp}: ${err.message}`)
						cleanup(false)
					}
				})
			})
		}

		doInit().catch((e) => {
			logger.warn(`ConMon init failed for ${deviceIp}: ${e}`)
			cleanup(false)
		})
	})
}

// ─── Device probe ─────────────────────────────────────────────────────────────

/**
 * Sends a unicast Dante info request to a specific IP and waits for the device info
 * response. Used to verify a manually configured IP.
 *
 * @param txSocket         Bound socket to send the query from
 * @param registerListener Register a callback (keyed) to receive parsed DeviceInfo responses
 * @param removeListener   Remove a previously registered listener by key
 * @param ensureMembership Ensure multicast membership on the outgoing interface
 * @param ip               Target device IP
 * @param timeoutMs        Timeout in milliseconds
 */
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
