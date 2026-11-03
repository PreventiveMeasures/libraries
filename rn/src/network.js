// DevTools' Network panel for runtimes that report no requests (React Native < 0.83): where the app answers
// Network.enable with an error, rn-serve answers it and relays, as CDP Network events, the requests that
// app/network.js (in each dev bundle) reports. Runtimes that answer Network.enable are left alone.

import { STATUS_CODES } from 'node:http'
import { fileURLToPath } from 'node:url'

// Injected into each dev bundle when DevTools are available.
export const REPORTER = fileURLToPath(new URL('../app/network.js', import.meta.url))
// Where app/network.js keeps the reporter's id on the global object.
const REPORTER_GLOBAL = '__rnServeReporter'
// Ids of rn-serve's own requests to a runtime start here, past any a DevTools sends.
const ASKED = 1_000_000_000

// Characters of response bodies kept, as React Native's own inspector keeps 100 MB.
const MAX_BODIES = 100 * 1024 * 1024
// How long a reporter may hold its startup requests for a DevTools that may yet connect.
const WAIT = 10_000
const MAX_FRAMES = 50
const TYPE = 'XHR'

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isTime = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
const headersOf = (value) => (isObject(value) ? Object.fromEntries(Object.entries(value).filter(([, each]) => typeof each === 'string')) : {})

export function createNetworkInspector({ wait = WAIT, maxBodies = MAX_BODIES } = {}) {
  const sessions = new Set()
  const reporters = new Set()
  const bodies = createBodies(maxBodies)
  let connecting = null
  let count = 0
  let asked = ASKED
  let ended = -Infinity

  // A session's `network` is 'pending' until its runtime answers Network.enable, then 'native' (it reports
  // itself) or 'served' (by rn-serve), and 'off' once DevTools disable it. `reporter` is its runtime's reporter id.
  const servedBy = (reporter) => [...sessions].filter((session) => session.network === 'served' && reporter.id !== null && session.reporter === reporter.id)
  // A reporter holds its startup requests until told: 'on' while a DevTools serves it; 'wait' while one may yet
  // (one undecided, its runtime being asked or naming an unknown reporter, or one just gone); else 'off'.
  const verdict = (reporter) => {
    if (servedBy(reporter).length > 0) return 'on'
    const known = new Set([...reporters].map(({ id }) => id))
    const open = [...sessions].some((session) => session.network === 'pending' || (session.network === 'served' && (session.asking.size > 0 || !known.has(session.reporter))))
    return open || Date.now() - ended < wait ? 'wait' : 'off'
  }
  const told = (reporter) => tell(reporter, verdict(reporter), wait)
  const retell = () => reporters.forEach(told)
  // Asks the runtime for its reporter's id (DevTools never see this), so an app's requests reach only its DevTools.
  const ask = (session) => {
    session.asking.add(++asked)
    session.device.sendMessage({ id: asked, method: 'Runtime.evaluate', params: { expression: `globalThis.${REPORTER_GLOBAL}`, returnByValue: true } })
  }
  const askServed = () => {
    for (const session of sessions) if (session.network === 'served') ask(session)
  }
  const end = (session) => {
    if (!sessions.delete(session)) return
    ended = Date.now()
    // With no DevTools served, no body is asked for again.
    if (![...sessions].some(({ network }) => network === 'served')) bodies.clear()
    retell()
  }

  return {
    // dev-middleware's unstable_customInspectorMessageHandler, per DevTools connection; a device has one at a time.
    handler({ device, debugger: frontend }) {
      for (const other of sessions) if (other.device.id === device.id && other.socket === null) end(other)
      const session = { device, frontend, socket: connecting, enabling: new Set(), asking: new Set(), network: 'pending', reporter: null, scripts: new Map() }
      sessions.add(session)
      session.socket?.once('close', () => end(session))
      return {
        handleDebuggerMessage: (message) => debuggerMessage(session, message, { bodies, retell }),
        handleDeviceMessage: (message) => deviceMessage(session, message, { retell, ask }),
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
      const reporter = { client, n: ++count, id: null, said: false, state: 'new', timer: null, inflight: new Set(), time: 0 }
      reporters.add(reporter)
      return {
        onMessage: (text) => reported(reporter, text, { servedBy, told, askServed, bodies }),
        onClose: () => {
          reporters.delete(reporter)
          clearTimeout(reporter.timer)
          // Its requests in flight fail: the app is gone, or reloaded.
          const served = servedBy(reporter)
          for (const id of reporter.inflight) send(served, () => ({ method: 'Network.loadingFailed', params: { requestId: id, timestamp: reporter.time, type: TYPE, errorText: 'The app went away', canceled: false } }))
        },
      }
    },
  }
}

// A message from DevTools to the app; true if rn-serve answers it instead.
function debuggerMessage(session, message, { bodies, retell }) {
  const method = message?.method
  if (method === 'Network.enable') session.enabling.add(message.id)
  if (session.network !== 'served') return undefined
  if (method === 'Network.disable') {
    session.network = 'off'
    session.frontend.sendMessage({ id: message.id, result: {} })
    retell()
    return true
  }
  if (method === 'Network.getResponseBody') {
    const body = bodies.get(message.params?.requestId)
    session.frontend.sendMessage(body === null ? { id: message.id, error: { code: -32_000, message: 'No data found for resource with given identifier' } } : { id: message.id, result: body })
    return true
  }
  return undefined
}

// A message from the app to DevTools; true if it is for rn-serve: an answer to rn-serve's question, or a
// Network.enable error, which rn-serve answers in the app's place. A Network.enable success means 'native'.
function deviceMessage(session, message, { retell, ask }) {
  if (!isObject(message)) return undefined
  const url = message.params?.url
  if (message.method === 'Debugger.scriptParsed' && typeof url === 'string' && url !== '') {
    session.scripts.set(url, String(message.params.scriptId))
    return undefined
  }
  if (!('id' in message)) return undefined
  if (session.asking.delete(message.id)) {
    const value = message.result?.result?.value
    session.reporter = typeof value === 'string' ? value : null
    retell()
    return true
  }
  if (!session.enabling.delete(message.id)) return undefined
  if (message.error === undefined) {
    if (session.network === 'pending') session.network = 'native'
    retell()
    return undefined
  }
  session.network = 'served'
  session.frontend.sendMessage({ id: message.id, result: {} })
  ask(session)
  retell()
  return true
}

// Tells the reporter 'on' or 'off'; one not yet told may wait up to `wait` ms first.
function tell(reporter, verdict, wait) {
  if (!reporter.said) return
  if (verdict === 'wait' && reporter.state === 'new') {
    if (reporter.timer === null) {
      reporter.timer = setTimeout(() => say(reporter, 'off'), wait)
      reporter.timer.unref?.()
    }
    return
  }
  const state = verdict === 'on' ? 'on' : 'off'
  if (reporter.state !== state) say(reporter, state)
}

// Once off, a reporter reports nothing more, not even the requests it had in flight.
function say(reporter, state) {
  clearTimeout(reporter.timer)
  reporter.timer = null
  reporter.state = state
  if (state === 'off') reporter.inflight.clear()
  reporter.client.send(JSON.stringify({ type: state === 'on' ? 'enable' : 'disable' }))
}

const send = (sessions, eventOf) => {
  for (const session of sessions) session.frontend.sendMessage(eventOf(session))
}

// A reporter's message: its hello with its id, then each request's events.
function reported(reporter, text, { servedBy, told, askServed, bodies }) {
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
    askServed()
    return told(reporter)
  }
  if (!Number.isSafeInteger(message.id) || (message.time !== undefined && !isTime(message.time))) return
  const requestId = `${reporter.n}.${message.id}`
  reporter.time = Math.max(reporter.time, message.time ?? 0)
  if (message.type === 'body') {
    if (typeof message.data === 'string' && Number.isSafeInteger(message.at)) bodies.add(requestId, message, message.base64 === true)
    return
  }
  // Of EVENTS' own types alone: not toString, constructor, of its prototype.
  if (!Object.hasOwn(EVENTS, message.type)) return
  const eventOf = EVENTS[message.type]
  const event = (session) => eventOf(requestId, message, session)
  if (event(null) === null) return
  if (message.type === 'request') reporter.inflight.add(requestId)
  if (message.type === 'finished' || message.type === 'failed') reporter.inflight.delete(requestId)
  send(servedBy(reporter), event)
}

// A reporter's event as CDP's, or null if the message is malformed.
const EVENTS = {
  request: (requestId, { url, method, headers, postData, hasPostData, time, wallTime, stack }, session) => {
    if (typeof url !== 'string' || typeof method !== 'string' || !isTime(time) || !isTime(wallTime)) return null
    const request = { url, method, headers: headersOf(headers), ...(typeof postData === 'string' && { postData }), hasPostData: hasPostData === true, initialPriority: 'High', referrerPolicy: 'no-referrer' }
    return { method: 'Network.requestWillBeSent', params: { requestId, loaderId: '', documentURL: 'mobile', request, timestamp: time, wallTime, initiator: initiatorOf(stack, session), redirectHasExtraInfo: false, type: TYPE } }
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
function initiatorOf(stack, session) {
  if (!Array.isArray(stack) || session === null) return { type: 'other' }
  const callFrames = stack.slice(0, MAX_FRAMES).filter((frame) => isObject(frame) && typeof frame.file === 'string' && Number.isSafeInteger(frame.lineNumber) && frame.lineNumber > 0).map(({ methodName, file, lineNumber, column }) => ({
    functionName: typeof methodName === 'string' && methodName !== '<unknown>' ? methodName : '',
    scriptId: session.scripts.get(file) ?? '',
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
    add(id, { data, at, more }, base64) {
      const body = kept.get(id) ?? { chunks: [], base64, size: 0, text: null }
      if (body.text !== null || at !== body.size) return
      // Re-added below, as the newest.
      kept.delete(id)
      body.chunks.push(data)
      body.size += data.length
      if (!more) [body.text, body.chunks] = [body.chunks.join(''), []]
      kept.set(id, body)
      size += data.length
      for (const [oldest, { size: dropped }] of kept) {
        if (size <= max) break
        size -= dropped
        kept.delete(oldest)
      }
    },
    get(id) {
      const body = kept.get(id)
      return body?.text == null ? null : { body: body.text, base64Encoded: body.base64 }
    },
    clear() {
      kept.clear()
      size = 0
    },
  }
}
