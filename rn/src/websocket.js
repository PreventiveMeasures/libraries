// The server side of a WebSocket (RFC 6455), for what React Native's dev clients send: small
// text messages, no extensions, no subprotocols. Client frames must be masked.

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_MESSAGE = 1024 * 1024
const [CONTINUATION, TEXT, BINARY, CLOSE, PING, PONG] = [0, 1, 2, 8, 9, 10]
const utf8 = new TextDecoder('utf-8', { fatal: true })

const frameOf = (opcode, payload) => {
  const { length } = payload
  // The 7-bit length, else 126 or 127 and how many bytes the length takes after it.
  const [short, extended] = length < 126 ? [length, 0] : length < 65_536 ? [126, 2] : [127, 8]
  const head = Buffer.alloc(2 + extended)
  head[0] = 0x80 | opcode
  head[1] = short
  if (extended === 2) head.writeUInt16BE(length, 2)
  if (extended === 8) head.writeBigUInt64BE(BigInt(length), 2)
  return Buffer.concat([head, payload])
}

// Completes the handshake of an upgrade request, else answers 400. `connect(client)`, the client being
// { request, send(text) }, returns its { onMessage(text), onClose() }; it's called before any frame is read.
export function acceptWebSocket(request, socket, head, connect) {
  const key = request.headers['sec-websocket-key']
  if (request.method !== 'GET' || request.headers.upgrade?.toLowerCase() !== 'websocket' || request.headers['sec-websocket-version'] !== '13' || typeof key !== 'string' || Buffer.from(key, 'base64').length !== 16) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    return
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64')
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  socket.setNoDelay(true)
  let closed = false
  const write = (opcode, payload) => {
    if (!closed && socket.writable) socket.write(frameOf(opcode, payload))
  }
  const { onMessage, onClose } = connect({ request, send: (text) => write(TEXT, Buffer.from(text)) })
  // Once, as the connection closes from either side.
  const ended = () => {
    if (closed) return
    closed = true
    onClose()
  }
  const close = (code) => {
    write(CLOSE, Buffer.from([code >> 8, code & 0xff]))
    socket.end()
    ended()
  }

  // The fragmented message being received, if any.
  let message = null
  const frame = (fin, opcode, payload) => {
    if (opcode > BINARY) {
      // A control frame is whole and of at most 125 bytes; the other opcodes are reserved.
      if (!fin || payload.length > 125 || opcode < CLOSE || opcode > PONG) return close(1002)
      if (opcode === CLOSE) close(1000)
      else if (opcode === PING) write(PONG, payload)
      return
    }
    if (opcode === CONTINUATION ? message === null : message !== null) return close(1002)
    message ??= { opcode, parts: [], size: 0 }
    message.parts.push(payload)
    message.size += payload.length
    if (message.size > MAX_MESSAGE) return close(1009)
    if (!fin) return
    const { opcode: kind, parts } = message
    message = null
    if (kind !== TEXT) return
    let text
    try {
      text = utf8.decode(Buffer.concat(parts))
    } catch {
      return close(1007)
    }
    onMessage(text)
  }

  let buffer = Buffer.alloc(0)
  const read = (chunk) => {
    if (closed) return
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
    while (buffer.length >= 2) {
      const [first, second] = buffer
      if ((first & 0x70) !== 0 || (second & 0x80) === 0) return close(1002)
      const short = second & 0x7f
      // Where the mask starts, past the length.
      const at = short === 126 ? 4 : short === 127 ? 10 : 2
      if (buffer.length < at) return
      const length = short === 126 ? buffer.readUInt16BE(2) : short === 127 ? Number(buffer.readBigUInt64BE(2)) : short
      if (length > MAX_MESSAGE) return close(1009)
      const next = at + 4 + length
      if (buffer.length < next) return
      const mask = buffer.subarray(at, at + 4)
      const payload = Buffer.from(buffer.subarray(at + 4, next))
      for (let i = 0; i < length; i++) payload[i] ^= mask[i & 3]
      buffer = buffer.subarray(next)
      frame((first & 0x80) !== 0, first & 0x0f, payload)
      if (closed) return
    }
  }
  socket.on('data', read)
  socket.on('error', ended)
  socket.on('close', ended)
  if (head.length > 0) read(head)
}
