// React Native DevTools' Network panel, for an app whose runtime reports no
// request (React Native before 0.83): dev-middleware shows the panel
// (its enableNetworkInspector), and where the app answers the panel's
// Network.enable with an error, rn-serve answers it, and sends the panel each
// request the app's reporter (app/network.js, in each dev bundle) tells it of,
// as CDP's Network events: requestWillBeSent, responseReceived,
// loadingFinished or loadingFailed; and the response's body for
// Network.getResponseBody, the newest kept, MAX_BODIES characters of them,
// as React Native's own keeps 100 MB of them. A runtime that answers
// Network.enable reports its requests itself: rn-serve leaves its DevTools
// be.
// An app's requests go to each DevTools of a runtime that loaded its bundle,
// as the runtime's Debugger.scriptParsed names it, or of one that named none
// yet; their call stacks in the scripts it names (the Initiator). Each
// DevTools by its connection (dev-middleware's custom inspector message
// handler, of each device and debugger), until its socket closes. A reporter
// keeps the requests of the app's start until rn-serve first says: rn-serve
// has it report while a DevTools is there for it, lets it wait while one may
// yet be (one connected, its runtime not asked yet, or one just gone, of an
// app reloaded), for `wait` ms at most; and else has it not report.

import { STATUS_CODES } from 'node:http'
import { fileURLToPath } from 'node:url'

// The reporter: in each dev bundle rn-serve serves where DevTools are.
export const REPORTER = fileURLToPath(new URL('../app/network.js', import.meta.url))

const MAX_BODIES = 100 * 1024 * 1024
// How long a reporter is let keep the requests of the app's start for a
// DevTools that may yet be there for it.
const WAIT = 10_000
const MAX_FRAMES = 50
const TYPE = 'XHR'

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isTime = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
const headersOf = (value) => (isObject(value) ? Object.fromEntries(Object.entries(value).filter(([, each]) => typeof each === 'string')) : {})

// `keyOf(url)`: the bundle a URL names, else null. -> { handler(connection),
// debuggerConnected(socket), reporter(client) -> { onMessage, onClose } }.
export function createNetworkInspector({ keyOf, log = () => {}, wait = WAIT, maxBodies = MAX_BODIES }) {
  const sessions = new Set()
  const reporters = new Set()
  const bodies = createBodies(maxBodies)
  let connecting = null
  let count = 0
  let ended = -Infinity

  // A session's `network`: 'pending' until its runtime answers Network.enable;
  // 'native', where it reports its requests itself; 'served', by rn-serve;
  // 'off', where its DevTools disabled it since.
  const of = (reporter, network) => [...sessions].filter((session) => session.network === network && (reporter.key === null || session.keys.size === 0 || session.keys.has(reporter.key)))
  const servedBy = (reporter) => of(reporter, 'served')
  const verdict = (reporter) => (servedBy(reporter).length > 0 ? 'on' : of(reporter, 'pending').length > 0 || Date.now() - ended < wait ? 'wait' : 'off')
  const told = (reporter) => tell(reporter, verdict(reporter), wait)
  const retell = () => reporters.forEach(told)
  const end = (session) => {
    if (!sessions.delete(session)) return
    ended = Date.now()
    retell()
  }

  return {
    // dev-middleware's unstable_customInspectorMessageHandler: a DevTools
    // of a device, which has one at a time.
    handler({ device, debugger: frontend }) {
      for (const other of sessions) if (other.device.id === device.id && other.socket === null) end(other)
      const session = { device, frontend, socket: connecting, enabling: new Set(), network: 'pending', keys: new Set(), scripts: new Map() }
      sessions.add(session)
      session.socket?.once('close', () => end(session))
      return {
        handleDebuggerMessage: (message) => debuggerMessage(session, message, { bodies, retell }),
        handleDeviceMessage: (message) => deviceMessage(session, message, { keyOf, log, retell }),
      }
    },
    // The socket of /inspector/debug a handler is made for as it connects,
    // before dev-middleware's own listener: its close ends that DevTools.
    debuggerConnected(socket) {
      connecting = socket
      queueMicrotask(() => {
        if (connecting === socket) connecting = null
      })
    },
    // An app's reporter, on rn-serve's /network.
    reporter(client) {
      const reporter = { client, n: ++count, key: null, said: false, state: 'new', timer: null, inflight: new Set(), time: 0 }
      reporters.add(reporter)
      return {
        onMessage: (text) => reported(reporter, text, { keyOf, servedBy, told, bodies }),
        onClose: () => {
          reporters.delete(reporter)
          clearTimeout(reporter.timer)
          // What it left going, failed: the app is gone, or reloaded.
          for (const id of reporter.inflight) send(servedBy(reporter), () => ({ method: 'Network.loadingFailed', params: { requestId: id, timestamp: reporter.time, type: TYPE, errorText: 'The app went away', canceled: false } }))
        },
      }
    },
  }
}

// A message of the DevTools to its app. -> true where rn-serve answers it.
function debuggerMessage(session, message, { bodies, retell }) {
  if (!isObject(message) || typeof message.method !== 'string') return undefined
  if (message.method === 'Network.enable') {
    session.enabling.add(message.id)
    return undefined
  }
  if (session.network !== 'served') return undefined
  if (message.method === 'Network.disable') {
    session.network = 'off'
    session.frontend.sendMessage({ id: message.id, result: {} })
    retell()
    return true
  }
  if (message.method === 'Network.getResponseBody') {
    const body = bodies.get(message.params?.requestId)
    session.frontend.sendMessage(body === null ? { id: message.id, error: { code: -32_000, message: 'No data found for resource with given identifier' } } : { id: message.id, result: body })
    return true
  }
  return undefined
}

// A message of the app to its DevTools. -> true where rn-serve answers in
// its place: an error of Network.enable, which rn-serve answers; its answer
// else says it reports its requests itself.
function deviceMessage(session, message, { keyOf, log, retell }) {
  if (!isObject(message)) return undefined
  if (message.method === 'Debugger.scriptParsed' && isObject(message.params) && typeof message.params.url === 'string' && message.params.url !== '') {
    const { url, scriptId } = message.params
    session.scripts.set(url, String(scriptId))
    const key = keyOf(url)
    if (key !== null && !session.keys.has(key)) {
      session.keys.add(key)
      retell()
    }
    return undefined
  }
  if (!('id' in message) || !session.enabling.delete(message.id)) return undefined
  if (message.error === undefined) {
    if (session.network === 'pending') session.network = 'native'
    retell()
    return undefined
  }
  if (session.network !== 'served') log(`rn-serve: ${session.device.appId} on ${session.device.name} reports no requests itself: its DevTools' Network panel has those its reporter tells of`)
  session.network = 'served'
  session.frontend.sendMessage({ id: message.id, result: {} })
  retell()
  return true
}

// Has the reporter report ('on'), or not; one not told yet let keep the
// requests of the app's start for `wait` ms at most where it may yet.
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

function say(reporter, state) {
  clearTimeout(reporter.timer)
  reporter.timer = null
  reporter.state = state
  reporter.client.send(JSON.stringify({ type: state === 'on' ? 'enable' : 'disable' }))
}

const send = (sessions, eventOf) => {
  for (const session of sessions) session.frontend.sendMessage(eventOf(session))
}

// A message of a reporter: its hello, which names its bundle, then each
// request's events, as app/network.js sends them.
function reported(reporter, text, { keyOf, servedBy, told, bodies }) {
  let message
  try {
    message = JSON.parse(text)
  } catch {
    return
  }
  if (!isObject(message)) return
  if (message.type === 'hello') {
    reporter.key = typeof message.bundle === 'string' ? keyOf(message.bundle) : null
    reporter.said = true
    return told(reporter)
  }
  if (!Number.isSafeInteger(message.id) || (message.time !== undefined && !isTime(message.time))) return
  const requestId = `${reporter.n}.${message.id}`
  reporter.time = Math.max(reporter.time, message.time ?? 0)
  if (message.type === 'body') {
    if (typeof message.data === 'string' && Number.isSafeInteger(message.at)) bodies.add(requestId, message, message.base64 === true)
    return
  }
  const eventOf = EVENTS[message.type]
  if (eventOf === undefined) return
  const event = (session) => eventOf(requestId, message, session)
  if (event(null) === null) return
  if (message.type === 'request') reporter.inflight.add(requestId)
  if (message.type === 'finished' || message.type === 'failed') reporter.inflight.delete(requestId)
  send(servedBy(reporter), event)
}

// Each event of a request as CDP's: null where the message is no such event.
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

// A request's call stack, React Native's parseErrorStack()'s frames, in the
// scripts the DevTools' runtime parsed: what of it the Initiator has.
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

// The responses' bodies, as their chunks come, each in order (`at`, its
// offset), the oldest dropped past `max` characters of them. -> { add(id, {
// data, at, more }, base64), get(id) -> { body, base64Encoded }, else null }.
function createBodies(max) {
  const kept = new Map()
  let size = 0
  const drop = (id) => {
    size -= kept.get(id)?.size ?? 0
    kept.delete(id)
  }
  return {
    add(id, { data, at, more }, base64) {
      const body = kept.get(id) ?? { chunks: [], base64, size: 0, done: false }
      if (body.done || at !== body.size) return
      kept.delete(id)
      body.chunks.push(data)
      body.size += data.length
      body.done = !more
      kept.set(id, body)
      size += data.length
      for (const oldest of kept.keys()) {
        if (size <= max) break
        drop(oldest)
      }
    },
    get(id) {
      const body = kept.get(id)
      if (body === undefined || !body.done) return null
      return { body: body.chunks.join(''), base64Encoded: body.base64 }
    },
  }
}
