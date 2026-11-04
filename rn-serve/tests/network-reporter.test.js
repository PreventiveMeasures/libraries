import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { setImmediate as tick } from 'node:timers/promises'
import { runInNewContext } from 'node:vm'

// serve/app/network.js, run as a dev bundle runs it, of an app's globals as React
// Native's: an XMLHttpRequest of its events (readystatechange, then abort,
// error, timeout or load, then loadend), a WebSocket, a FileReader.
const SOURCE = readFileSync(new URL('../src/app/network.js', import.meta.url), 'utf8')
const BUNDLE = 'http://localhost:8081/index.bundle//&platform=ios&dev=true'
const FRAMES = [{ methodName: 'send', file: BUNDLE, lineNumber: 90, column: 2 }, { methodName: 'loadUser', file: BUNDLE, lineNumber: 12, column: 4 }]

class Target {
  listeners = new Map()
  added = new Set()
  addEventListener(type, listener) {
    this.added.add(type)
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((each) => each !== listener))
  }
  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener({ type, ...event })
  }
}

class Xhr extends Target {
  readyState = 0
  status = 0
  responseType = ''
  responseURL = ''
  _response = ''
  blob = null
  headers = null
  open(method, url) {
    Object.assign(this, { readyState: 1, url })
  }
  setRequestHeader() {}
  send(body) {
    this.body = body
  }
  setResponseHeaders(headers) {
    this.headers = headers
  }
  getAllResponseHeaders() {
    return this.headers === null ? null : Object.entries(this.headers).map(([name, value]) => `${name}: ${value}`).join('\r\n')
  }
  get responseText() {
    assert.ok(this.responseType === '' || this.responseType === 'text', 'responseText of another responseType')
    return this._response
  }
  get response() {
    return this.responseType === 'blob' ? this.blob : this._response
  }
  // As React Native's: the response's headers, its URL after.
  respond(status, headers, url = this.url) {
    this.status = status
    this.setResponseHeaders(headers)
    this.readyState = 2
    this.emit('readystatechange')
    this.responseURL = url
  }
  end(outcome, response = '') {
    this._response = response
    this.readyState = 4
    this.emit('readystatechange')
    this.emit(outcome)
    this.emit('loadend')
  }
}

// The app: its globals, rn-serve's sockets, its timers. `modules`, what of
// react-native the reporter's require() finds.
function app({ devServer = { url: 'http://localhost:8081/', bundleLoadedFromServer: true }, modules } = {}) {
  const sockets = []
  const timers = []
  const clock = { now: 1000 }
  class WebSocket extends Target {
    sent = []
    constructor(url) {
      super()
      this.url = url
      sockets.push(this)
    }
    send(text) {
      this.sent.push(JSON.parse(text))
    }
  }
  const reads = []
  class FileReader extends Target {
    read(how, result) {
      reads.push(how)
      queueMicrotask(() => {
        this.result = result
        this.emit('load')
      })
    }
    readAsText(blob) {
      this.read('text', blob.text)
    }
    readAsDataURL(blob) {
      this.read('base64', `data:${blob.type};base64,${Buffer.from(blob.text).toString('base64')}`)
    }
  }
  class XMLHttpRequest extends Xhr {}
  const found = modules ?? {
    'react-native/Libraries/Core/Devtools/getDevServer': () => devServer,
    'react-native/Libraries/Core/Devtools/parseErrorStack': { default: (stack) => (typeof stack === 'string' ? FRAMES : []) },
  }
  const context = { XMLHttpRequest, WebSocket, FileReader, performance: { now: () => clock.now }, setTimeout: (run, ms) => timers.push({ run, ms }) }
  context.globalThis = context
  runInNewContext(`(function (require) {\n${SOURCE}\n})`, context)((specifier) => {
    if (Object.hasOwn(found, specifier)) return found[specifier]
    throw Object.assign(new Error(`Cannot find module '${specifier}'`), { code: 'MODULE_NOT_FOUND' })
  })
  return { sockets, timers, clock, XMLHttpRequest, context, reads }
}

// The app's socket, open, rn-serve having said `type`.
const told = (socket, type) => {
  socket.emit('open')
  socket.emit('message', { data: JSON.stringify({ type }) })
}
const sent = (socket) => socket.sent.slice(1)

describe("network's reporter, of an app", () => {
  it('keeps the requests of its start until rn-serve first says, then tells it of each: sent, responded to, its body, finished', () => {
    const { sockets, clock, XMLHttpRequest, context } = app()
    const xhr = new XMLHttpRequest()
    xhr.open('get', 'https://api.example/user')
    xhr.setRequestHeader('Accept', 'application/json')
    xhr.send()
    const [socket] = sockets
    assert.equal(socket.url, 'ws://localhost:8081/network')
    told(socket, 'enable')
    // Named by the id it keeps on the global object, which rn-serve asks the runtime for.
    assert.deepEqual([socket.sent[0], Object.keys(context).includes('__rnServeReporter')], [{ type: 'hello', reporter: context.__rnServeReporter }, false])
    assert.match(context.__rnServeReporter, /^\w+\.\w+$/u)
    clock.now = 1250
    xhr.respond(200, { 'Content-Type': 'application/json; charset=utf-8' }, 'https://api.example/user/42')
    clock.now = 1500
    xhr.end('load', '{"id":42}')
    const [request, ...rest] = sent(socket)
    assert.deepEqual({ ...request, wallTime: typeof request.wallTime }, { type: 'request', id: 1, url: 'https://api.example/user', method: 'GET', headers: { Accept: 'application/json' }, time: 1, wallTime: 'number', stack: FRAMES.slice(1) })
    assert.deepEqual(rest, [
      { type: 'response', id: 1, url: 'https://api.example/user/42', status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' }, mimeType: 'application/json', time: 1.25 },
      { type: 'body', id: 1, at: 0, data: '{"id":42}', base64: false, more: false },
      { type: 'finished', id: 1, time: 1.5, size: 9 },
    ])
    // No listener of readystatechange, which React Native's takes to ask for a response in parts.
    assert.deepEqual([xhr.added.has('readystatechange'), xhr.added.has('progress')], [false, false])
  })

  it('drops what it kept where rn-serve says not to, and tells it of nothing more', () => {
    const { sockets, XMLHttpRequest } = app()
    const xhr = new XMLHttpRequest()
    xhr.open('POST', 'https://api.example/orders')
    xhr.send('{"item":1}')
    told(sockets[0], 'disable')
    xhr.respond(201, {})
    xhr.end('load', '{}')
    const later = new XMLHttpRequest()
    later.open('GET', 'https://api.example/later')
    later.send()
    assert.deepEqual([sent(sockets[0]), later.added.size], [[], 0])
  })

  it("reads a blob's body, as fetch's is: as text, of a text type, else as base64; json's and arraybuffer's as they came", async () => {
    const { sockets, XMLHttpRequest, reads } = app()
    told(sockets[0], 'enable')
    for (const [name, type, text] of [['logo.png', 'image/png', 'PNG\0'], ['user', 'application/json; charset=utf-8', '{"id":1}']]) {
      const fetched = new XMLHttpRequest()
      fetched.open('GET', `https://api.example/${name}`)
      fetched.responseType = 'blob'
      fetched.send()
      fetched.respond(200, { 'content-type': type })
      fetched.blob = { size: text.length, type, text }
      fetched.end('load')
    }
    await tick()
    for (const [id, responseType, response] of [[3, 'json', '{"a": 1}'], [4, 'arraybuffer', 'AAEC']]) {
      const xhr = new XMLHttpRequest()
      xhr.open('GET', `https://api.example/${id}`)
      xhr.responseType = responseType
      xhr.send()
      xhr.respond(200, {})
      xhr.end('load', response)
    }
    const bodies = sent(sockets[0]).filter(({ type }) => type === 'body' || type === 'finished').map(({ type, id, data, base64, size }) => (type === 'body' ? [id, data, base64] : [id, size]))
    assert.deepEqual(bodies, [[1, Buffer.from('PNG\0').toString('base64'), true], [1, 4], [2, '{"id":1}', false], [2, 8], [3, '{"a": 1}', false], [3, 8], [4, 'AAEC', true], [4, 3]])
    assert.deepEqual(reads, ['base64', 'text'])
  })

  it('reads no body once rn-serve says not to, nor one more than it may keep until rn-serve says', async () => {
    const { sockets, XMLHttpRequest, reads } = app()
    const request = (name, size) => {
      const xhr = new XMLHttpRequest()
      xhr.open('GET', `https://api.example/${name}`)
      xhr.responseType = 'blob'
      xhr.send()
      xhr.respond(200, { 'content-type': 'text/plain' })
      xhr.blob = { size, type: 'text/plain', text: 'x'.repeat(size) }
      return xhr
    }
    const [small, large] = [request('small', 10), request('large', 5 * 1024 * 1024)]
    small.end('load')
    large.end('load')
    await tick()
    told(sockets[0], 'enable')
    // The large one unread, finished at once; the small one's read.
    assert.deepEqual(sent(sockets[0]).filter(({ type }) => type !== 'request' && type !== 'response').map(({ type, id }) => [type, id]), [['finished', 2], ['body', 1], ['finished', 1]])
    const late = request('late', 10)
    sockets[0].emit('message', { data: JSON.stringify({ type: 'disable' }) })
    late.end('load')
    await tick()
    assert.deepEqual(reads, ['text'])
  })

  it('sends a body in chunks, each at its offset, none of which splits a surrogate pair', () => {
    const { sockets, XMLHttpRequest } = app()
    told(sockets[0], 'enable')
    const body = `${'a'.repeat(39_999)}\u{1F600}${'b'.repeat(50_000)}`
    const xhr = new XMLHttpRequest()
    xhr.open('GET', 'https://api.example/big')
    xhr.send(`${'x'.repeat(40_001)}`)
    xhr.respond(200, {})
    xhr.end('load', body)
    const messages = sent(sockets[0])
    assert.deepEqual([messages[0].hasPostData, 'postData' in messages[0]], [true, false])
    const chunks = messages.filter(({ type }) => type === 'body')
    assert.deepEqual(chunks.map(({ at, data, more }) => [at, data.length, more]), [[0, 39_999, true], [39_999, 40_000, true], [79_999, 10_002, false]])
    assert.equal(chunks.map(({ data }) => data).join(''), body)
  })

  it('tells of a request that was canceled, timed out or failed, its response first where one came', () => {
    const { sockets, XMLHttpRequest } = app()
    told(sockets[0], 'enable')
    for (const [outcome, response, status] of [['abort', '', 0], ['timeout', '', 0], ['error', 'The Internet connection appears to be offline.', 0], ['error', '', 502]]) {
      const xhr = new XMLHttpRequest()
      xhr.open('GET', 'https://api.example/x')
      xhr.send()
      if (status > 0) xhr.respond(status, {})
      xhr.end(outcome, response)
    }
    const ends = sent(sockets[0]).filter(({ type }) => type !== 'request').map(({ type, id, error, canceled, status }) => (type === 'failed' ? [id, error, canceled] : [id, status]))
    assert.deepEqual(ends, [[1, 'Canceled', true], [2, 'Timed out', false], [3, 'The Internet connection appears to be offline.', false], [4, 502], [4, 'Failed', false]])
  })

  it('opens its socket again where it closes, and keeps nothing until rn-serve says anew', () => {
    const { sockets, timers, XMLHttpRequest } = app()
    told(sockets[0], 'enable')
    sockets[0].emit('error')
    sockets[0].emit('close')
    assert.deepEqual(timers.map(({ ms }) => ms), [2000])
    timers[0].run()
    const xhr = new XMLHttpRequest()
    xhr.open('GET', 'https://api.example/x')
    xhr.send()
    told(sockets[1], 'enable')
    assert.deepEqual([sockets.length, sent(sockets[1])], [2, []])
  })

  it('is no reporter where the bundle is no dev server\'s, or react-native has no getDevServer', () => {
    assert.equal(app({ devServer: { url: 'http://localhost:8081/', bundleLoadedFromServer: false } }).sockets.length, 0)
    const { sockets, XMLHttpRequest } = app({ modules: {} })
    assert.deepEqual([sockets.length, Object.hasOwn(XMLHttpRequest.prototype, 'send')], [0, false])
  })
})
