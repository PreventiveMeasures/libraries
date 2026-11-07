// DevTools' Network panel for runtimes that report no requests (React Native < 0.83): where the app answers
// Network.enable with an error, rn-serve answers it and relays, as CDP Network events, the requests that
// app/network.js (in each dev bundle) reports. Runtimes that answer Network.enable are left alone.

import { STATUS_CODES } from 'node:http'
import { fileURLToPath } from 'node:url'

// Injected into each dev bundle when DevTools are available.
export const REPORTER = fileURLToPath(new URL('app/network.js', import.meta.url))
// Where app/network.js keeps the reporter's id on the global object.
const REPORTER_GLOBAL = '__rnServeReporter'
// Characters of response bodies kept, as React Native's own inspector keeps 100 MB.
const MAX_BODIES = 100 * 1024 * 1024
// How long a reporter may hold its startup requests for a DevTools that may yet connect.
const WAIT = 10_000
const MAX_FRAMES = 50
const TYPE = 'XHR'
// Ids of rn-serve's own requests to a runtime, past any a DevTools sends.
let asked = 1_000_000_000

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isTime = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
const headersOf = (value) => (isObject(value) ? Object.fromEntries(Object.entries(value).filter(([, each]) => typeof each === 'string')) : {})

// `hub` has the DevTools sessions and the apps' reporters. A session's `network` is 'pending' until its runtime
// answers Network.enable, then 'served' (by rn-serve) if it failed it, else 'off', as once DevTools disable it;
// `reporter` is its runtime's reporter id. A reporter's `told` is 'enable' or 'disable', as last told; null before.
export function createNetworkInspector({ wait = WAIT, maxBodies = MAX_BODIES } = {}) {
  const hub = { sessions: new Set(), reporters: new Set(), bodies: createBodies(maxBodies), wait, ended: -Infinity }
  let connecting = null
  let count = 0
  return {
    // dev-middleware's unstable_customInspectorMessageHandler, per DevTools connection; a device has one at a time.
    handler({ device, debugger: frontend }) {
      for (const other of hub.sessions) if (other.device.id === device.id && other.socket === null) end(hub, other)
      const session = { device, frontend, socket: connecting, network: 'pending', reporter: null, enabling: new Set(), asking: new Set(), scripts: new Map() }
      hub.sessions.add(session)
      session.socket?.once('close', () => end(hub, session))
      return {
        handleDebuggerMessage: (message) => debuggerMessage(hub, session, message),
        handleDeviceMessage: (message) => deviceMessage(hub, session, message),
      }
    },
    // Prepended to /inspector/debug's listeners: the handler made next takes this socket, and ends on its close.
    debuggerConnected(socket) {
      connecting = socket
      queueMicrotask(() => {
        if (connecting === socket) connecting = null
      })
    },
    // An app's reporter, connected to rn-serve's /network.
    reporter(client) {
      const reporter = { client, n: ++count, id: null, said: false, told: null, timer: null, inflight: new Set(), time: 0 }
      hub.reporters.add(reporter)
      return { onMessage: (text) => reported(hub, reporter, text), onClose: () => gone(hub, reporter) }
    },
  }
}

const servedBy = (hub, reporter) => [...hub.sessions].filter((session) => session.network === 'served' && reporter.id !== null && session.reporter === reporter.id)

// Tells each of `reporters` that said hello to enable while a DevTools serves it, else to disable. One not yet
// told holds its startup requests, up to `wait` ms, while one may yet: a DevTools undecided, its runtime being
// asked or naming an unknown reporter, or one just gone.
function retell(hub, reporters = hub.reporters) {
  const known = new Set(hub.reporters.values().map(({ id }) => id))
  const open = hub.sessions.values().some((session) => session.network === 'pending' || (session.network === 'served' && (session.asking.size > 0 || !known.has(session.reporter))))
  const waiting = open || Date.now() - hub.ended < hub.wait
  for (const reporter of reporters) {
    if (!reporter.said) continue
    const type = servedBy(hub, reporter).length > 0 ? 'enable' : 'disable'
    if (type === 'disable' && waiting && reporter.told === null) reporter.timer ??= setTimeout(() => say(reporter, 'disable'), hub.wait).unref()
    else if (reporter.told !== type) say(reporter, type)
  }
}

// Once told to disable, a reporter reports nothing more, not even the requests it had in flight.
function say(reporter, type) {
  clearTimeout(reporter.timer)
  reporter.told = type
  if (type === 'disable') reporter.inflight.clear()
  reporter.client.send(JSON.stringify({ type }))
}

// Asks the runtime for its reporter's id (DevTools never see this), so an app's requests reach only its DevTools.
function ask(session) {
  session.asking.add(++asked)
  session.device.sendMessage({ id: asked, method: 'Runtime.evaluate', params: { expression: `globalThis.${REPORTER_GLOBAL}`, returnByValue: true } })
}

function end(hub, session) {
  if (!hub.sessions.delete(session)) return
  hub.ended = Date.now()
  // With no DevTools served, no body is asked for again.
  if (!hub.sessions.values().some(({ network }) => network === 'served')) hub.bodies.clear()
  retell(hub)
}

// A message from DevTools to the app; true if rn-serve answers it instead.
function debuggerMessage(hub, session, message) {
  const method = message?.method
  if (method === 'Network.enable') session.enabling.add(message.id)
  if (session.network !== 'served') return
  if (method === 'Network.disable') {
    session.network = 'off'
    session.frontend.sendMessage({ id: message.id, result: {} })
    retell(hub)
    return true
  }
  if (method === 'Network.getResponseBody') {
    const body = hub.bodies.get(message.params?.requestId)
    session.frontend.sendMessage(body === null ? { id: message.id, error: { code: -32_000, message: 'No data found for resource with given identifier' } } : { id: message.id, result: body })
    return true
  }
}

// A message from the app to DevTools; true if it is for rn-serve: an answer to rn-serve's question, or a
// Network.enable error, which rn-serve answers in the app's place.
function deviceMessage(hub, session, message) {
  if (!isObject(message)) return
  const url = message.params?.url
  if (message.method === 'Debugger.scriptParsed' && typeof url === 'string' && url !== '') {
    session.scripts.set(url, String(message.params.scriptId))
    return
  }
  if (!('id' in message)) return
  if (session.asking.delete(message.id)) {
    const value = message.result?.result?.value
    session.reporter = typeof value === 'string' ? value : null
    retell(hub)
    return true
  }
  if (!session.enabling.delete(message.id)) return
  if (message.error === undefined) {
    if (session.network === 'pending') session.network = 'off'
    retell(hub)
    return
  }
  session.network = 'served'
  session.frontend.sendMessage({ id: message.id, result: {} })
  ask(session)
  retell(hub)
  return true
}

// A reporter's message: its hello with its id, then each request's events.
function reported(hub, reporter, text) {
  let message
  try {
    message = JSON.parse(text)
  } catch {
    return
  }
  if (!isObject(message)) return
  if (message.type === 'hello') {
    reporter.id = typeof message.reporter === 'string' && message.reporter !== '' ? message.reporter : null
    reporter.said = true
    // A DevTools of its runtime, if any, now answers with its id.
    for (const session of hub.sessions) if (session.network === 'served') ask(session)
    retell(hub, [reporter])
    return
  }
  if (!Number.isSafeInteger(message.id) || (message.time !== undefined && !isTime(message.time))) return
  const requestId = `${reporter.n}.${message.id}`
  reporter.time = Math.max(reporter.time, message.time ?? 0)
  if (message.type === 'body') {
    if (typeof message.data === 'string' && Number.isSafeInteger(message.at)) hub.bodies.add(requestId, message)
    return
  }
  // Of EVENTS' own types alone: not toString, constructor, of its prototype.
  if (!Object.hasOwn(EVENTS, message.type)) return
  const eventOf = EVENTS[message.type]
  // Checked though no DevTools is served: a request in flight fails as its app goes.
  if (eventOf(requestId, message) === null) return
  if (message.type === 'request') reporter.inflight.add(requestId)
  if (message.type === 'finished' || message.type === 'failed') reporter.inflight.delete(requestId)
  for (const session of servedBy(hub, reporter)) session.frontend.sendMessage(eventOf(requestId, message, session.scripts))
}

// Its requests in flight fail: the app is gone, or reloaded.
function gone(hub, reporter) {
  hub.reporters.delete(reporter)
  clearTimeout(reporter.timer)
  const served = servedBy(hub, reporter)
  for (const requestId of reporter.inflight) {
    const event = EVENTS.failed(requestId, { time: reporter.time, error: 'The app went away' })
    for (const session of served) session.frontend.sendMessage(event)
  }
}

// A reporter's event as CDP's, or null if the message is malformed; a request's initiator is in `scripts`.
const EVENTS = {
  request: (requestId, { url, method, headers, postData, hasPostData, time, wallTime, stack }, scripts = new Map()) => {
    if (typeof url !== 'string' || typeof method !== 'string' || !isTime(time) || !isTime(wallTime)) return null
    const request = { url, method, headers: headersOf(headers), ...(typeof postData === 'string' && { postData }), hasPostData: hasPostData === true, initialPriority: 'High', referrerPolicy: 'no-referrer' }
    return { method: 'Network.requestWillBeSent', params: { requestId, loaderId: '', documentURL: 'mobile', request, timestamp: time, wallTime, initiator: initiatorOf(stack, scripts), redirectHasExtraInfo: false, type: TYPE } }
  },
  response: (requestId, { url, status, statusText, headers, mimeType, time }) => {
    if (typeof url !== 'string' || !Number.isSafeInteger(status) || !isTime(time)) return null
    const response = { url, status, statusText: typeof statusText === 'string' && statusText !== '' ? statusText : (STATUS_CODES[status] ?? ''), headers: headersOf(headers), mimeType: typeof mimeType === 'string' ? mimeType : '', connectionReused: false, connectionId: 0, encodedDataLength: 0, securityState: 'unknown' }
    return { method: 'Network.responseReceived', params: { requestId, loaderId: '', timestamp: time, type: TYPE, response, hasExtraInfo: false } }
  },
  finished: (requestId, { time, size }) => (isTime(time) ? { method: 'Network.loadingFinished', params: { requestId, timestamp: time, encodedDataLength: isTime(size) ? size : 0 } } : null),
  failed: (requestId, { time, error, canceled }) => (isTime(time) ? { method: 'Network.loadingFailed', params: { requestId, timestamp: time, type: TYPE, errorText: typeof error === 'string' ? error : '', canceled: canceled === true } } : null),
}

// The Initiator of a request from its stack (React Native's parseErrorStack() frames), in the runtime's parsed scripts.
function initiatorOf(stack, scripts) {
  if (!Array.isArray(stack)) return { type: 'other' }
  const callFrames = stack.slice(0, MAX_FRAMES).filter((frame) => isObject(frame) && typeof frame.file === 'string' && Number.isSafeInteger(frame.lineNumber) && frame.lineNumber > 0).map(({ methodName, file, lineNumber, column }) => ({
    functionName: typeof methodName === 'string' && methodName !== '<unknown>' ? methodName : '',
    scriptId: scripts.get(file) ?? '',
    url: file,
    lineNumber: lineNumber - 1,
    columnNumber: Number.isSafeInteger(column) && column >= 0 ? column : 0,
  }))
  return callFrames.some(({ scriptId }) => scriptId !== '') ? { type: 'script', stack: { callFrames } } : { type: 'other' }
}

// Response bodies assembled from in-order chunks (`at` is the offset), dropping the oldest past `max` characters.
function createBodies(max) {
  const kept = new Map()
  let size = 0
  return {
    add(id, { data, at, more, base64 }) {
      const body = kept.get(id) ?? { text: '', base64: base64 === true, done: false }
      if (body.done || at !== body.text.length) return
      // Re-added below, as the newest.
      kept.delete(id)
      body.text += data
      body.done = !more
      kept.set(id, body)
      size += data.length
      for (const [oldest, { text }] of kept) {
        if (size <= max) break
        size -= text.length
        kept.delete(oldest)
      }
    },
    get(id) {
      const body = kept.get(id)
      return body?.done ? { body: body.text, base64Encoded: body.base64 } : null
    },
    clear() {
      kept.clear()
      size = 0
    },
  }
}
