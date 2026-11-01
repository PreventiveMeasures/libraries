// The server's side of a WebSocket (RFC 6455), for what React Native's dev
// clients send: small text messages, no extensions, no subprotocols. Frames
// from a client must be masked; a message is at most MAX_MESSAGE bytes.

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
export const MAX_MESSAGE = 1024 * 1024
const [CONTINUATION, TEXT, BINARY, CLOSE, PING, PONG] = [0, 1, 2, 8, 9, 10]
const utf8 = new TextDecoder('utf-8', { fatal: true })

const frameOf = (opcode, payload) => {
  const length = payload.length
  const head = Buffer.alloc(length < 126 ? 2 : length < 65_536 ? 4 : 10)
  head[0] = 0x80 | opcode
  if (head.length === 2) {
    head[1] = length
  } else if (head.length === 4) {
    head[1] = 126
    head.writeUInt16BE(length, 2)
  } else {
    head[1] = 127
    head.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([head, payload])
}

// Completes the handshake of an upgrade request. -> { request, send(text),
// close(code) }, or null where it is no WebSocket handshake (answered 400).
export function acceptWebSocket(request, socket, head, { onMessage = () => {}, onClose = () => {} } = {}) {
  const key = request.headers['sec-websocket-key']
  if (request.method !== 'GET' || request.headers.upgrade?.toLowerCase() !== 'websocket' || request.headers['sec-websocket-version'] !== '13' || typeof key !== 'string' || Buffer.from(key, 'base64').length !== 16) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    return null
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64')
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  socket.setNoDelay(true)
  let closed = false
  const end = () => {
    if (closed) return
    closed = true
    onClose()
  }
  const write = (opcode, payload) => {
    if (!closed && socket.writable) socket.write(frameOf(opcode, payload))
  }
  const close = (code = 1000) => {
    if (closed) return
    const payload = Buffer.alloc(2)
    payload.writeUInt16BE(code)
    write(CLOSE, payload)
    socket.end()
    end()
  }
  const client = { request, send: (text) => write(TEXT, Buffer.from(text)), close }
  const reader = frameReader({ onMessage: (text) => onMessage(text, client), ping: (payload) => write(PONG, payload), close })
  socket.on('data', reader)
  socket.on('error', end)
  socket.on('close', end)
  if (head.length > 0) reader(head)
  return client
}

function frameReader({ onMessage, ping, close: closeSocket }) {
  let buffer = Buffer.alloc(0)
  let done = false
  const close = (code) => {
    done = true
    closeSocket(code)
  }
  // The data frames of a message so far, and its opcode, while it lasts.
  let parts = null
  let kind = 0
  let size = 0
  const message = (fin, opcode, payload) => {
    if (opcode === CONTINUATION ? parts === null : parts !== null) return close(1002)
    if (opcode !== CONTINUATION) [parts, kind, size] = [[], opcode, 0]
    parts.push(payload)
    size += payload.length
    if (size > MAX_MESSAGE) return close(1009)
    if (!fin) return true
    const data = Buffer.concat(parts)
    parts = null
    if (kind !== TEXT) return true
    let text
    try {
      text = utf8.decode(data)
    } catch {
      return close(1007)
    }
    onMessage(text)
    return true
  }
  const frame = (fin, opcode, payload) => {
    if (opcode === TEXT || opcode === BINARY || opcode === CONTINUATION) return message(fin, opcode, payload)
    if (!fin || payload.length > 125) return close(1002)
    if (opcode === PING) ping(payload)
    if (opcode === PING || opcode === PONG) return true
    return close(opcode === CLOSE ? 1000 : 1002)
  }
  return (chunk) => {
    if (done) return
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
    while (buffer.length >= 2) {
      const [first, second] = buffer
      let length = second & 0x7f
      let at = 2
      if (length === 126) {
        if (buffer.length < 4) return
        ;[length, at] = [buffer.readUInt16BE(2), 4]
      } else if (length === 127) {
        if (buffer.length < 10) return
        if (buffer.readUInt32BE(2) !== 0) return close(1009)
        ;[length, at] = [buffer.readUInt32BE(6), 10]
      }
      if ((first & 0x70) !== 0 || (second & 0x80) === 0) return close(1002)
      if (length > MAX_MESSAGE) return close(1009)
      if (buffer.length < at + 4 + length) return
      const mask = buffer.subarray(at, at + 4)
      const payload = Buffer.from(buffer.subarray(at + 4, at + 4 + length))
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
      buffer = buffer.subarray(at + 4 + length)
      if (frame((first & 0x80) !== 0, first & 0x0f, payload) !== true) return
    }
  }
}
