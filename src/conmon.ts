import dgram from 'dgram'
import { createModuleLogger } from '@companion-module/base'
import { getMacForDestination, getLocalAddressForDestination } from './dante.js'

const logger = createModuleLogger('ConMon')

/** Coalesces concurrent openConMonSession calls per IP */
const _conmonPending = new Map<string, Promise<(() => void) | null>>()

/**
 * Opens a Dante ConMon session with the device on port 8800.
 * Only needed for devices with "useConMon": true in their device JSON.
 * Returns a cleanup function to stop keepalives and close the socket, or null on failure.
 */
export async function openConMonSession(deviceIp: string, timeoutMs = 3000): Promise<(() => void) | null> {
	const pending = _conmonPending.get(deviceIp)
	if (pending) return pending

	const promise = _doConMonSession(deviceIp, timeoutMs).finally(() => {
		_conmonPending.delete(deviceIp)
	})
	_conmonPending.set(deviceIp, promise)
	return promise
}

async function _doConMonSession(deviceIp: string, timeoutMs: number): Promise<(() => void) | null> {
	return new Promise<(() => void) | null>((resolve) => {
		let settled = false
		let keepaliveTimer: ReturnType<typeof setInterval> | null = null

		const closeSession = (sock: dgram.Socket) => {
			if (keepaliveTimer) {
				clearInterval(keepaliveTimer)
				keepaliveTimer = null
			}
			try {
				sock.close()
			} catch {
				/* ignore */
			}
			logger.debug(`ConMon session closed for ${deviceIp}`)
		}

		const fail = (sock: dgram.Socket) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			closeSession(sock)
			logger.debug(`ConMon session not established for ${deviceIp}`)
			resolve(null)
		}

		const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
		const timer = setTimeout(() => fail(sock), timeoutMs)

		sock.on('error', (err) => {
			logger.warn(`ConMon socket error for ${deviceIp}: ${err.message}`)
			fail(sock)
		})

		sock.on('message', (msg: Buffer) => {
			// Device ACK: type byte 0x20 at offset 3
			if (!settled && msg.length >= 4 && msg[0] === 0x12 && msg[3] === 0x20) {
				settled = true
				clearTimeout(timer)
				logger.info(`ConMon session established with ${deviceIp}`)

				let keepaliveSeq = Math.floor(Math.random() * 0xfffe) + 1
				const sendKeepalive = () => {
					const pkt = Buffer.alloc(20, 0)
					pkt[0] = 0x12
					pkt[3] = 0x4e
					pkt.writeUInt16BE(keepaliveSeq++ & 0xffff, 4)
					pkt[6] = 0x30
					pkt[7] = 0x10
					sock.send(pkt, 8800, deviceIp, () => {
						/* fire and forget */
					})
				}
				keepaliveTimer = setInterval(sendKeepalive, 1000)
				resolve(() => closeSession(sock))
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
				fail(sock)
				return
			}

			sock.bind({ port: 8800, address: localIp }, () => {
				const seq = Math.floor(Math.random() * 0xfffe) + 1
				const pkt = Buffer.alloc(20, 0)
				pkt[0] = 0x12
				pkt[3] = 0x14
				pkt.writeUInt16BE(seq, 4)
				pkt[6] = 0x10
				pkt[7] = 0x01
				localMac.forEach((b, i) => {
					pkt[12 + i] = b
				})
				logger.debug(`ConMon TX to ${deviceIp}: ${pkt.toString('hex')}`)
				sock.send(pkt, 8800, deviceIp, (err) => {
					if (err) {
						logger.warn(`ConMon send failed for ${deviceIp}: ${err.message}`)
						fail(sock)
					}
				})
			})
		}

		doInit().catch((e) => {
			logger.warn(`ConMon init failed for ${deviceIp}: ${e}`)
			fail(sock)
		})
	})
}
