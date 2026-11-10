// rn-serve's network reporter (src/network.js), in each dev bundle rn-serve
// serves where React Native DevTools are: run after InitializeCore, before
// the entry, its imports react-native's, resolved as the entry's are. It
// names itself to rn-serve by an id it keeps on the global object, which
// rn-serve asks the runtime of each DevTools for: whose requests these are.
// It tells rn-serve, on its /network socket, of each request an XMLHttpRequest
// makes (fetch's too: React Native's is of one) while rn-serve asks: as it
// is sent, with its call stack; as it ends, its response's status and
// headers (as they came, where setResponseHeaders() is there to say when),
// its body (its text; json's and arraybuffer's as React Native's _response
// has them; a blob's read, as text where of a text type, else as base64),
// in chunks; or that it failed. Those of the app's start kept until
// rn-serve first says. Of the XMLHttpRequest's open(), setRequestHeader()
// and send(), and its abort, error, timeout and loadend events, of no
// listener of readystatechange, which has React Native's ask for a
// response in parts.

'use strict'

// A module's function, CommonJS's or an ES module's default.
const functionOf = (module) => (typeof module === 'function' ? module : typeof module?.default === 'function' ? module.default : null)

// Without getDevServer, no reporter; without parseErrorStack, no call stacks.
let getDevServer = null
let parseErrorStack = null
try {
  getDevServer = functionOf(require('react-native/Libraries/Core/Devtools/getDevServer'))
  parseErrorStack = functionOf(require('react-native/Libraries/Core/Devtools/parseErrorStack'))
} catch {
  // No react-native of it.
}

// Characters of a body a message: rn-serve takes a message of 1 MiB at most,
// which JSON's escapes, and UTF-8, make a chunk up to six times as large.
const CHUNK = 40_000
const MAX_MESSAGE = 300_000
const MAX_BODY = 16 * 1024 * 1024
// Characters of messages kept until rn-serve first says.
const MAX_KEPT = 4 * 1024 * 1024
const MAX_FRAMES = 50
const RETRY = 2000
const MAX_RETRY = 60_000
const FAILED = ['abort', 'error', 'timeout']
// Where it keeps its id on the global object (src/network.js's).
const REPORTER_GLOBAL = '__rnServeReporter'
// A blob of these types read as text, any other as base64.
const TEXT = /^text\/|json|xml|javascript|x-www-form-urlencoded/u

const now = () => (typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now()) / 1000

function install() {
  const { XMLHttpRequest, WebSocket } = globalThis
  if (getDevServer === null || typeof XMLHttpRequest !== 'function' || typeof WebSocket !== 'function') return
  const { url, bundleLoadedFromServer } = getDevServer()
  if (!bundleLoadedFromServer) return
  // Its id, which rn-serve asks the runtime of each DevTools for, to tell
  // whose requests these are.
  const id = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`
  Object.defineProperty(globalThis, REPORTER_GLOBAL, { value: id, configurable: true })
  watch(XMLHttpRequest.prototype, createReporter(`${url.startsWith('https:') ? 'wss' : 'ws'}${url.slice(url.indexOf(':'))}network`, id))
}

// rn-serve's socket: `state` 'new' until rn-serve first says, keeping what
// it is told; 'on', sending it; 'off'. Opened again where it closes, which
// rn-serve says of anew.
function createReporter(socketUrl, id) {
  let state = 'new'
  let kept = []
  let keptSize = 0
  let socket = null
  let retry = RETRY
  const stop = () => {
    state = 'off'
    kept = []
  }
  const connect = () => {
    const ws = new globalThis.WebSocket(socketUrl)
    socket = ws
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      stop()
      setTimeout(connect, retry)
      retry = Math.min(retry * 2, MAX_RETRY)
    }
    ws.addEventListener('open', () => {
      retry = RETRY
      ws.send(JSON.stringify({ type: 'hello', reporter: id }))
    })
    ws.addEventListener('message', ({ data }) => {
      const type = typeOf(data)
      if (type === 'enable') {
        state = 'on'
        for (const text of kept) ws.send(text)
        kept = []
      } else if (type === 'disable') {
        stop()
      }
    })
    ws.addEventListener('close', close)
    ws.addEventListener('error', close)
  }
  connect()
  return {
    reporting: () => state !== 'off',
    // Whether a request sent now is to be told of.
    tracking: () => state === 'on' || (state === 'new' && keptSize < MAX_KEPT),
    // Characters of a body it may yet take.
    room: () => (state === 'on' ? MAX_BODY : state === 'new' ? MAX_KEPT - keptSize : 0),
    // -> whether it took the message.
    send(message) {
      if (state === 'off') return false
      const text = JSON.stringify(message)
      if (text.length > MAX_MESSAGE) return false
      if (state === 'on') {
        socket.send(text)
        return true
      }
      if (message.type === 'body' && keptSize + text.length > MAX_KEPT) return false
      kept.push(text)
      keptSize += text.length
      return true
    },
  }
}

function typeOf(data) {
  try {
    return JSON.parse(data)?.type
  } catch {
    return undefined
  }
}

// Each request of an XMLHttpRequest, as open() and setRequestHeader() name
// it, from its send(): `sent`, of the request it sent last.
function watch(proto, reporter) {
  const requests = new WeakMap()
  const { open, setRequestHeader, send, setResponseHeaders } = proto
  let seq = 0
  proto.open = function (method, url, ...rest) {
    requests.set(this, { method: String(method).toUpperCase(), url: String(url), headers: {}, sent: null })
    return open.call(this, method, url, ...rest)
  }
  proto.setRequestHeader = function (name, value) {
    const request = requests.get(this)
    if (request !== undefined) request.headers[String(name)] = String(value)
    return setRequestHeader.call(this, name, value)
  }
  proto.send = function (body) {
    const request = requests.get(this)
    if (request !== undefined && this.readyState === 1 && reporter.tracking()) {
      request.sent = { id: ++seq, url: request.url, outcome: null, headersAt: null }
      reporter.send(requestMessage(request.sent.id, request, body, new Error('sent').stack))
      follow(this, request.sent, reporter)
    }
    return send.call(this, body)
  }
  if (typeof setResponseHeaders === 'function') {
    proto.setResponseHeaders = function (...args) {
      const sent = requests.get(this)?.sent
      if (sent != null && sent.headersAt === null) sent.headersAt = now()
      return setResponseHeaders.apply(this, args)
    }
  }
}

function requestMessage(id, { url, method, headers }, body, stack) {
  const message = { type: 'request', id, url, method, headers: { ...headers }, time: now(), wallTime: Date.now() / 1000, stack: framesOf(stack) }
  if (body != null) message.hasPostData = true
  if (typeof body === 'string' && body.length <= CHUNK) message.postData = body
  return message
}

// The stack's frames, but send()'s own, as React Native parses one.
function framesOf(stack) {
  if (parseErrorStack === null || typeof stack !== 'string') return undefined
  try {
    return parseErrorStack(stack).slice(1, MAX_FRAMES + 1).map(({ methodName, file, lineNumber, column }) => ({ methodName, file, lineNumber, column }))
  } catch {
    return undefined
  }
}

// The request's end: its outcome, by the events before loadend.
function follow(xhr, sent, reporter) {
  const failed = (event) => {
    sent.outcome = event.type
  }
  const ended = () => {
    for (const type of FAILED) xhr.removeEventListener(type, failed)
    xhr.removeEventListener('loadend', ended)
    end(xhr, sent, reporter)
  }
  for (const type of FAILED) xhr.addEventListener(type, failed)
  xhr.addEventListener('loadend', ended)
}

function end(xhr, { id, url, outcome, headersAt }, reporter) {
  if (!reporter.reporting()) return
  const time = now()
  const headers = headersOf(xhr)
  const type = Object.keys(headers).find((name) => name.toLowerCase() === 'content-type')
  const mimeType = type === undefined ? '' : headers[type].split(';')[0].trim()
  if (xhr.status > 0) reporter.send({ type: 'response', id, url: xhr.responseURL || url, status: xhr.status, headers, mimeType, time: headersAt ?? time })
  if (outcome !== null) {
    const message = outcome === 'abort' ? 'Canceled' : outcome === 'timeout' ? 'Timed out' : typeof xhr._response === 'string' && xhr._response !== '' ? xhr._response : 'Failed'
    reporter.send({ type: 'failed', id, time, error: message, canceled: outcome === 'abort' })
    return
  }
  bodyOf(xhr, mimeType, reporter.room(), (data, base64, size) => {
    if (data !== null) chunks(reporter, id, data, base64)
    reporter.send({ type: 'finished', id, time, size })
  })
}

// The response's headers, as getAllResponseHeaders() has them.
function headersOf(xhr) {
  const headers = {}
  const text = typeof xhr.getAllResponseHeaders === 'function' ? xhr.getAllResponseHeaders() : null
  for (const line of String(text ?? '').split('\n')) {
    const at = line.indexOf(':')
    if (at > 0) headers[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return headers
}

// -> done(data, base64, size): its body, base64 where binary, else null
// where there is none, or more than `room` characters of it; its size.
function bodyOf(xhr, mimeType, room, done) {
  const limit = Math.min(MAX_BODY, room)
  const type = xhr.responseType
  const fits = (data) => (data.length <= limit ? data : null)
  if (type === '' || type === 'text') {
    const text = xhr.responseText
    return done(fits(text), false, text.length)
  }
  // As it came: json's text, an arraybuffer's base64.
  const raw = xhr._response
  if (type === 'json' && typeof raw === 'string') return done(fits(raw), false, raw.length)
  if (type === 'arraybuffer' && typeof raw === 'string') return done(fits(raw), true, Math.floor((raw.length * 3) / 4))
  const blob = type === 'blob' ? xhr.response : null
  if (blob == null || typeof globalThis.FileReader !== 'function') return done(null, false, 0)
  // As text, of as many characters as bytes at most; as base64, of 4 of each 3.
  const text = TEXT.test(mimeType || blob.type || '')
  if (!((text ? blob.size : Math.ceil(blob.size / 3) * 4) <= limit)) return done(null, false, blob.size)
  const reader = new globalThis.FileReader()
  reader.addEventListener('load', () => {
    const { result } = reader
    if (typeof result !== 'string') return done(null, false, blob.size)
    // Of a data URL, what follows its comma.
    done(text ? result : result.slice(result.indexOf(',') + 1), !text, blob.size)
  })
  reader.addEventListener('error', () => done(null, false, blob.size))
  // eslint-disable-next-line unicorn/prefer-blob-reading-methods -- React Native's Blob has no text()
  if (text) reader.readAsText(blob)
  else reader.readAsDataURL(blob)
  return undefined
}

// The body in chunks, `at` each's offset, none of which splits a surrogate
// pair; none after one not taken.
function chunks(reporter, id, data, base64) {
  let at = 0
  do {
    let until = Math.min(at + CHUNK, data.length)
    // Of a pair, its code point: past U+FFFF.
    if (until < data.length && data.codePointAt(until - 1) > 0xff_ff) until--
    if (!reporter.send({ type: 'body', id, at, data: data.slice(at, until), base64, more: until < data.length })) return
    at = until
  } while (at < data.length)
}

install()
