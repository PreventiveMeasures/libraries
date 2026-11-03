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
// An app's requests go to the DevTools of its runtime alone: a reporter
// names itself (an id of its own, which it keeps on the global object, as
// REPORTER_GLOBAL), and rn-serve asks the runtime of each DevTools it serves
// which it has (Runtime.evaluate, its answer the DevTools never sees), as it
// serves it and as a reporter says hello; their call stacks in the scripts
// the runtime parsed (Debugger.scriptParsed), for the Initiator. Each
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
// Where the reporter keeps its id on the app's global object (app/network.js's).
const REPORTER_GLOBAL = '__rnServeReporter'
// rn-serve's own requests of a runtime: of ids no DevTools sends.
const ASKED = 1_000_000_000

const MAX_BODIES = 100 * 1024 * 1024
// How long a reporter is let keep the requests of the app's start for a
// DevTools that may yet be there for it.
const WAIT = 10_000
const MAX_FRAMES = 50
const TYPE = 'XHR'

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isTime = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
const headersOf = (value) => (isObject(value) ? Object.fromEntries(Object.entries(value).filter(([, each]) => typeof each === 'string')) : {})

// -> { handler(connection), debuggerConnected(socket), reporter(client) ->
// { onMessage, onClose } }.
export function createNetworkInspector({ wait = WAIT, maxBodies = MAX_BODIES } = {}) {
  const sessions = new Set()
  const reporters = new Set()
  const bodies = createBodies(maxBodies)
  let connecting = null
  let count = 0
  let asked = ASKED
  let ended = -Infinity

  // A session's `network`: 'pending' until its runtime answers Network.enable;
  // 'native', where it reports its requests itself; 'served', by rn-serve;
  // 'off', where its DevTools disabled it since. Its `reporter`: the id of
  // the reporter its runtime has, where rn-serve serves it and has asked.
  const servedBy = (reporter) => [...sessions].filter((session) => session.network === 'served' && reporter.id !== null && session.reporter === reporter.id)
  // 'wait', while a DevTools may yet be this reporter's: one not decided, one
  // whose runtime is asked, or has a reporter none known here, or one just gone.
  const verdict = (reporter) => {
    if (servedBy(reporter).length > 0) return 'on'
    const known = new Set([...reporters].map(({ id }) => id))
    const open = [...sessions].some((session) => session.network === 'pending' || (session.network === 'served' && (session.asking.size > 0 || !known.has(session.reporter))))
    return open || Date.now() - ended < wait ? 'wait' : 'off'
  }
  const told = (reporter) => tell(reporter, verdict(reporter), wait)
  const retell = () => reporters.forEach(told)
  // Which reporter the session's runtime has.
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
    // Of no DevTools served, no body is asked for again.
    if (![...sessions].some(({ network }) => network === 'served')) bodies.clear()
    retell()
  }

  return {
    // dev-middleware's unstable_customInspectorMessageHandler: a DevTools
    // of a device, which has one at a time.
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
      const reporter = { client, n: ++count, id: null, said: false, state: 'new', timer: null, inflight: new Set(), time: 0 }
      reporters.add(reporter)
      return {
        onMessage: (text) => reported(reporter, text, { servedBy, told, askServed, bodies }),
        onClose: () => {
          reporters.delete(reporter)
          clearTimeout(reporter.timer)
          // What it left going, failed: the app is gone, or reloaded.
          const served = servedBy(reporter)
          for (const id of reporter.inflight) send(served, () => ({ method: 'Network.loadingFailed', params: { requestId: id, timestamp: reporter.time, type: TYPE, errorText: 'The app went away', canceled: false } }))
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

// A message of the app to its DevTools. -> true where it is rn-serve's: the
// answer to what it asked, or an error of Network.enable, which rn-serve
// answers in its place; its answer else says it reports its requests itself.
function deviceMessage(session, message, { retell, ask }) {
  if (!isObject(message)) return undefined
  if (message.method === 'Debugger.scriptParsed' && isObject(message.params) && typeof message.params.url === 'string' && message.params.url !== '') {
    session.scripts.set(message.params.url, String(message.params.scriptId))
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

// Told not to, it tells of nothing more, of what it left going too.
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

// A message of a reporter: its hello, which names it, then each request's
// events, as app/network.js sends them.
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
    // Its runtime's DevTools, if one is there, says so.
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
// offset), joined as the last comes, the oldest dropped past `max`
// characters of them. -> { add(id, { data, at, more }, base64), get(id) ->
// { body, base64Encoded }, else null, clear() }.
function createBodies(max) {
  const kept = new Map()
  let size = 0
  return {
    add(id, { data, at, more }, base64) {
      const body = kept.get(id) ?? { chunks: [], base64, size: 0, text: null }
      if (body.text !== null || at !== body.size) return
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
