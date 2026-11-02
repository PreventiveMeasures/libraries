// rn-serve's network reporter (src/network.js), in each dev bundle rn-serve
// serves where React Native DevTools are: run after InitializeCore, before
// the entry, its imports react-native's, resolved as the entry's are. It
// tells rn-serve, on its /network socket, of each request an XMLHttpRequest
// makes (fetch's too: React Native's is of one) while rn-serve asks: as it
// is sent, with its call stack; as it ends, its response's status and
// headers (as they came, where setResponseHeaders() is there to say when),
// its body (its text; json's and arraybuffer's as React Native's _response
// has them; a blob's read), in chunks; or that it failed. Those of the
// app's start kept until rn-serve first says. Of the XMLHttpRequest's
// open(), setRequestHeader() and send(), and its abort, error, timeout and
// loadend events, of no listener of readystatechange, which has React
// Native's ask for a response in parts.

'use strict'

let devServerOf = null
let parseErrorStack = null
try {
  devServerOf = require('react-native/Libraries/Core/Devtools/getDevServer')
} catch {
  // No react-native of it: no reporter.
}
try {
  parseErrorStack = require('react-native/Libraries/Core/Devtools/parseErrorStack')
} catch {
  // No call stacks.
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

// A module's function, CommonJS's or an ES module's default.
const functionOf = (module) => (typeof module === 'function' ? module : typeof module?.default === 'function' ? module.default : null)
const now = (global) => (typeof global.performance?.now === 'function' ? global.performance.now() : Date.now()) / 1000

function install(global) {
  const devServer = functionOf(devServerOf)
  const XMLHttpRequest = global.XMLHttpRequest
  if (devServer === null || typeof XMLHttpRequest !== 'function' || typeof global.WebSocket !== 'function') return
  const { url, fullBundleUrl, bundleLoadedFromServer } = devServer()
  if (!bundleLoadedFromServer) return
  const socketUrl = `${url.startsWith('https:') ? 'wss' : 'ws'}${url.slice(url.indexOf(':'))}network`
  watch(XMLHttpRequest.prototype, createReporter(global, socketUrl, fullBundleUrl), global)
}

// rn-serve's socket: `state` 'new' until rn-serve first says, keeping what
// it is told; 'on', sending it; 'off'. Opened again where it closes, which
// rn-serve says of anew.
function createReporter(global, socketUrl, bundle) {
  let state = 'new'
  let kept = []
  let keptSize = 0
  let socket = null
  let retry = RETRY
  const stop = () => {
    state = 'off'
    kept = []
    keptSize = 0
  }
  const connect = () => {
    const ws = new global.WebSocket(socketUrl)
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      socket = null
      stop()
      setTimeout(connect, retry)
      retry = Math.min(retry * 2, MAX_RETRY)
    }
    ws.addEventListener('open', () => {
      socket = ws
      retry = RETRY
      ws.send(JSON.stringify({ type: 'hello', bundle }))
    })
    ws.addEventListener('message', ({ data }) => {
      const type = typeOf(data)
      if (type === 'enable') {
        state = 'on'
        for (const text of kept) ws.send(text)
        kept = []
        keptSize = 0
      } else if (type === 'disable') {
        stop()
      }
    })
    ws.addEventListener('close', close)
    ws.addEventListener('error', close)
  }
  connect()
  return {
    // Whether a request sent now is to be told of.
    tracking: () => state === 'on' || (state === 'new' && keptSize < MAX_KEPT),
    send(message) {
      if (state === 'off') return
      const text = JSON.stringify(message)
      if (text.length > MAX_MESSAGE) return
      if (state === 'on') {
        socket?.send(text)
      } else if (message.type !== 'body' || keptSize + text.length <= MAX_KEPT) {
        kept.push(text)
        keptSize += text.length
      }
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
// it, from its send().
function watch(proto, reporter, global) {
  const requests = new WeakMap()
  const { open, setRequestHeader, send, setResponseHeaders } = proto
  let seq = 0
  proto.open = function (method, url, ...rest) {
    requests.set(this, { method: String(method).toUpperCase(), url: String(url), headers: {}, current: null })
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
      const sent = { id: ++seq, outcome: null, headersAt: null }
      request.current = sent
      reporter.send(requestMessage(sent.id, request, body, new Error('sent').stack, global))
      follow(this, sent, request, reporter, global)
    }
    return send.call(this, body)
  }
  if (typeof setResponseHeaders === 'function') {
    proto.setResponseHeaders = function (...args) {
      const sent = requests.get(this)?.current
      if (sent != null && sent.headersAt === null) sent.headersAt = now(global)
      return setResponseHeaders.apply(this, args)
    }
  }
}

function requestMessage(id, { url, method, headers }, body, stack, global) {
  const message = { type: 'request', id, url, method, headers: { ...headers }, time: now(global), wallTime: Date.now() / 1000, stack: framesOf(stack) }
  if (body != null) message.hasPostData = true
  if (typeof body === 'string' && body.length <= CHUNK) message.postData = body
  return message
}

// The stack's frames, but send()'s own, as React Native parses one.
function framesOf(stack) {
  const parse = functionOf(parseErrorStack)
  if (parse === null || typeof stack !== 'string') return undefined
  try {
    return parse(stack).slice(1, MAX_FRAMES + 1).map(({ methodName, file, lineNumber, column }) => ({ methodName, file, lineNumber, column }))
  } catch {
    return undefined
  }
}

// The request's end: its outcome, by the events before loadend.
function follow(xhr, sent, request, reporter, global) {
  const failed = (event) => {
    sent.outcome = event.type
  }
  const ended = () => {
    for (const type of FAILED) xhr.removeEventListener(type, failed)
    xhr.removeEventListener('loadend', ended)
    if (request.current === sent) request.current = null
    end(xhr, sent, request, reporter, global)
  }
  for (const type of FAILED) xhr.addEventListener(type, failed)
  xhr.addEventListener('loadend', ended)
}

function end(xhr, { id, outcome, headersAt }, request, reporter, global) {
  const time = now(global)
  const headers = headersOf(xhr)
  if (xhr.status > 0) {
    const type = Object.keys(headers).find((name) => name.toLowerCase() === 'content-type')
    reporter.send({ type: 'response', id, url: xhr.responseURL || request.url, status: xhr.status, headers, mimeType: type === undefined ? '' : headers[type].split(';')[0].trim(), time: headersAt ?? time })
  }
  if (outcome !== null) {
    const message = outcome === 'abort' ? 'Canceled' : outcome === 'timeout' ? 'Timed out' : typeof xhr._response === 'string' && xhr._response !== '' ? xhr._response : 'Failed'
    reporter.send({ type: 'failed', id, time, error: message, canceled: outcome === 'abort' })
    return
  }
  bodyOf(xhr, global, (data, base64, size) => {
    if (data !== null && data.length <= MAX_BODY) chunks(reporter, id, data, base64)
    reporter.send({ type: 'finished', id, time, size: size ?? (data === null ? 0 : base64 ? Math.floor((data.length * 3) / 4) : data.length) })
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

// -> done(data, base64, size): its body, base64 where binary, else null.
function bodyOf(xhr, global, done) {
  const type = xhr.responseType
  if (type === '' || type === 'text') return done(xhr.responseText, false)
  // As it came: json's text, an arraybuffer's base64.
  if ((type === 'json' || type === 'arraybuffer') && typeof xhr._response === 'string') return done(xhr._response, type === 'arraybuffer')
  const blob = type === 'blob' ? xhr.response : null
  if (blob == null || typeof global.FileReader !== 'function' || !(blob.size <= MAX_BODY)) return done(null, false, blob?.size)
  const reader = new global.FileReader()
  reader.addEventListener('load', () => {
    const { result } = reader
    const at = typeof result === 'string' ? result.indexOf(',') : -1
    done(at === -1 ? null : result.slice(at + 1), true, blob.size)
  })
  reader.addEventListener('error', () => done(null, false, blob.size))
  reader.readAsDataURL(blob)
  return undefined
}

// The body in chunks, `at` each's offset, none of which splits a surrogate pair.
function chunks(reporter, id, data, base64) {
  let at = 0
  do {
    let until = Math.min(at + CHUNK, data.length)
    // Of a pair, its code point: past U+FFFF.
    if (until < data.length && data.codePointAt(until - 1) > 0xff_ff) until--
    reporter.send({ type: 'body', id, at, data: data.slice(at, until), base64, more: until < data.length })
    at = until
  } while (at < data.length)
}

install(globalThis)
