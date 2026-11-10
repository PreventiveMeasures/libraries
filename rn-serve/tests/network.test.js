import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'

import { createNetworkInspector } from '../src/network.js'

const BUNDLE = 'http://localhost:8081/index.bundle?platform=ios&dev=true'

const inspector = (options) => createNetworkInspector({ wait: 50, ...options })

// A DevTools of a device, as dev-middleware connects one; its runtime has
// the reporter `has`, which it answers rn-serve's Runtime.evaluate with.
const connect = (network, { id = 'phone', has } = {}) => {
  const toDebugger = []
  const toDevice = []
  let handler = null
  const fromDevice = (message) => handler.handleDeviceMessage(message)
  const sendMessage = (message) => {
    toDevice.push(message)
    if (message.method === 'Runtime.evaluate' && has !== undefined) queueMicrotask(() => assert.equal(fromDevice({ id: message.id, result: { result: { type: 'string', value: has } } }), true))
  }
  handler = network.handler({ page: { id: '1' }, device: { appId: 'com.app', id, name: 'Phone', sendMessage }, debugger: { userAgent: null, sendMessage: (message) => toDebugger.push(message) } })
  return {
    toDebugger,
    toDevice,
    fromDebugger: (message) => handler.handleDebuggerMessage(message),
    fromDevice,
    events: (method) => toDebugger.filter((message) => message.method === method),
  }
}

// A DevTools of a runtime that fails Network.enable, which rn-serve answers,
// and asks which reporter it has.
const served = (network, { id, has = 'r1' } = {}) => {
  const devtools = connect(network, { id, has })
  devtools.fromDevice({ method: 'Debugger.scriptParsed', params: { scriptId: '7', url: BUNDLE } })
  assert.equal(devtools.fromDebugger({ id: 1, method: 'Network.enable', params: {} }), undefined)
  assert.equal(devtools.fromDevice({ id: 1, error: { code: -32_601, message: "Unsupported method 'Network.enable'" } }), true)
  assert.deepEqual(devtools.toDebugger, [{ id: 1, result: {} }])
  assert.deepEqual(devtools.toDevice.map(({ method, params }) => [method, params.expression]), [['Runtime.evaluate', 'globalThis.__rnServeReporter']])
  devtools.toDebugger.length = 0
  return devtools
}

// A DevTools' socket of /inspector/debug, as ws has one: closed with close().
const socketOf = () => {
  const listeners = []
  return { once: (type, listener) => listeners.push(listener), close: () => listeners.forEach((listener) => listener()) }
}

// An app's reporter on rn-serve's /network, named `id`.
const report = (network, id = 'r1') => {
  const told = []
  const reporter = network.reporter({ send: (text) => told.push(JSON.parse(text).type) })
  const say = (message) => reporter.onMessage(JSON.stringify(message))
  say({ type: 'hello', reporter: id })
  return { told, say, close: reporter.onClose }
}

// A request, as serve/app/network.js tells of one: sent, responded to, its body in two chunks, finished.
const requestOf = (say, id, { url = 'https://api.example/user', stack } = {}) => {
  say({ type: 'request', id, url, method: 'GET', headers: { Accept: 'application/json' }, time: 1, wallTime: 1_700_000_000, stack })
  say({ type: 'response', id, url, status: 200, headers: { 'Content-Type': 'application/json' }, mimeType: 'application/json', time: 1.25 })
  say({ type: 'body', id, at: 0, data: '{"id":', base64: false, more: true })
  say({ type: 'body', id, at: 6, data: '42}', base64: false, more: false })
  say({ type: 'finished', id, time: 1.5, size: 9 })
}

describe('network: React Native DevTools\' Network panel', () => {
  it('leaves a runtime that reports its requests be: its Network.enable answered by it, the reporter told not to as it is', () => {
    const network = inspector()
    const devtools = connect(network)
    const { told } = report(network)
    assert.deepEqual(told, [])
    assert.equal(devtools.fromDebugger({ id: 3, method: 'Network.enable', params: {} }), undefined)
    assert.equal(devtools.fromDevice({ id: 3, result: {} }), undefined)
    assert.equal(devtools.fromDebugger({ id: 4, method: 'Network.getResponseBody', params: { requestId: '1.1' } }), undefined)
    assert.deepEqual([told, devtools.toDebugger, devtools.toDevice], [['disable'], [], []])
  })

  it('answers Network.enable where the runtime fails it, and has the reporter its runtime has report, once it says', async () => {
    const network = inspector()
    served(network)
    const { told } = report(network)
    assert.deepEqual(told, [])
    await sleep(0)
    assert.deepEqual(told, ['enable'])
    // One no runtime has: no DevTools is its, once the runtime says.
    const none = report(network, 'r9')
    await sleep(0)
    assert.deepEqual([none.told, told], [['disable'], ['enable']])
  })

  it("sends the panel each request as CDP's events, its stack in the runtime's scripts, its body for Network.getResponseBody", async () => {
    const network = inspector()
    const devtools = served(network)
    const { say } = report(network)
    await sleep(0)
    requestOf(say, 1, { stack: [{ methodName: 'loadUser', file: BUNDLE, lineNumber: 12, column: 4 }, { methodName: '<unknown>', file: 'http://elsewhere/x.js', lineNumber: 1, column: null }] })
    assert.deepEqual(devtools.toDebugger.map(({ method }) => method), ['Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFinished'])
    const [{ params: sent }] = devtools.events('Network.requestWillBeSent')
    assert.deepEqual([sent.requestId, sent.request, sent.timestamp, sent.type], ['1.1', { url: 'https://api.example/user', method: 'GET', headers: { Accept: 'application/json' }, hasPostData: false, initialPriority: 'High', referrerPolicy: 'no-referrer' }, 1, 'XHR'])
    assert.deepEqual(sent.initiator, { type: 'script', stack: { callFrames: [{ functionName: 'loadUser', scriptId: '7', url: BUNDLE, lineNumber: 11, columnNumber: 4 }, { functionName: '', scriptId: '', url: 'http://elsewhere/x.js', lineNumber: 0, columnNumber: 0 }] } })
    const [{ params: responded }] = devtools.events('Network.responseReceived')
    assert.deepEqual([responded.response.status, responded.response.statusText, responded.response.mimeType, responded.timestamp], [200, 'OK', 'application/json', 1.25])
    assert.deepEqual(devtools.events('Network.loadingFinished')[0].params, { requestId: '1.1', timestamp: 1.5, encodedDataLength: 9 })
    assert.equal(devtools.fromDebugger({ id: 9, method: 'Network.getResponseBody', params: { requestId: '1.1' } }), true)
    assert.deepEqual(devtools.toDebugger.at(-1), { id: 9, result: { body: '{"id":42}', base64Encoded: false } })
    // A stack of no script the runtime parsed: no initiator but other.
    requestOf(say, 2, { stack: [{ methodName: 'f', file: 'http://elsewhere/x.js', lineNumber: 3, column: 0 }] })
    assert.deepEqual(devtools.events('Network.requestWillBeSent')[1].params.initiator, { type: 'other' })
  })

  it('keeps no body of chunks out of order, nor any but the last of its size, and says so', async () => {
    const network = inspector({ maxBodies: 12 })
    const devtools = served(network)
    const { say } = report(network)
    await sleep(0)
    say({ type: 'body', id: 1, at: 3, data: 'late', base64: false, more: false })
    requestOf(say, 2)
    requestOf(say, 3)
    devtools.fromDebugger({ id: 10, method: 'Network.getResponseBody', params: { requestId: '1.1' } })
    devtools.fromDebugger({ id: 11, method: 'Network.getResponseBody', params: { requestId: '1.2' } })
    devtools.fromDebugger({ id: 12, method: 'Network.getResponseBody', params: { requestId: '1.3' } })
    assert.deepEqual(devtools.toDebugger.slice(-3).map((message) => message.result?.body ?? message.error.code), [-32_000, -32_000, '{"id":42}'])
  })

  it("sends an app's requests to the DevTools of its runtime alone, of the same bundle though another's", async () => {
    const network = inspector()
    const first = served(network, { id: 'iphone', has: 'r1' })
    const second = served(network, { id: 'ipad', has: 'r2' })
    const one = report(network, 'r1')
    const two = report(network, 'r2')
    await sleep(0)
    requestOf(one.say, 1)
    requestOf(two.say, 1)
    const ids = (devtools) => devtools.events('Network.requestWillBeSent').map(({ params }) => params.requestId)
    assert.deepEqual([ids(first), ids(second), one.told, two.told], [['1.1'], ['2.1'], ['enable'], ['enable']])
  })

  it('tells the reporter to stop as its DevTools go: on Network.disable, which rn-serve answers, and as its socket closes', async () => {
    const network = inspector()
    const devtools = served(network)
    const { told } = report(network)
    await sleep(0)
    assert.equal(devtools.fromDebugger({ id: 5, method: 'Network.disable' }), true)
    assert.deepEqual(devtools.toDebugger, [{ id: 5, result: {} }])
    const socket = socketOf()
    network.debuggerConnected(socket)
    served(network, { id: 'phone' })
    await sleep(0)
    socket.close()
    assert.deepEqual(told, ['enable', 'disable', 'enable', 'disable'])
    // One that comes as the app reloads, its DevTools just gone, waits for one to come.
    assert.deepEqual(report(network, 'r2').told, [])
  })

  it('has the reporter of an app reloaded report, its DevTools still there, its last reporter not gone yet', () => {
    const network = inspector()
    let has = 'r1'
    const devtools = connect(network)
    devtools.fromDebugger({ id: 1, method: 'Network.enable' })
    devtools.fromDevice({ id: 1, error: { message: 'Unsupported' } })
    const answer = () => {
      for (const { id } of devtools.toDevice.splice(0)) assert.equal(devtools.fromDevice({ id, result: { result: { type: 'string', value: has } } }), true)
    }
    answer()
    const last = report(network, 'r1')
    answer()
    has = 'r2'
    const reloaded = report(network, 'r2')
    assert.deepEqual(reloaded.told, [])
    answer()
    assert.deepEqual([last.told, reloaded.told, devtools.toDebugger], [['enable', 'disable'], ['enable'], [{ id: 1, result: {} }]])
  })

  it('takes a socket for the DevTools it is connecting alone, not for one connected later', async () => {
    const network = inspector()
    const earlier = socketOf()
    network.debuggerConnected(earlier)
    await sleep(0)
    const { told } = report(network)
    served(network)
    await sleep(0)
    earlier.close()
    assert.deepEqual(told, ['disable', 'enable'])
  })

  it('tells a reporter at once where no DevTools may come, and lets it keep the requests of its start while one may, a while', async () => {
    const network = inspector({ wait: 30 })
    assert.deepEqual(report(network).told, ['disable'])
    // A DevTools whose runtime is not asked yet.
    const devtools = connect(network, { has: 'r2' })
    const { told } = report(network, 'r2')
    await sleep(5)
    devtools.fromDebugger({ id: 1, method: 'Network.enable' })
    devtools.fromDevice({ id: 1, error: { message: 'Unsupported' } })
    await sleep(0)
    assert.deepEqual(told, ['enable'])
    // One whose runtime is never asked, a while alone.
    const other = inspector({ wait: 30 })
    connect(other)
    const late = report(other)
    await sleep(50)
    assert.deepEqual(late.told, ['disable'])
  })

  it('keeps no body once no DevTools is served, nor fails what a reporter told to stop left going', async () => {
    const network = inspector()
    const socket = socketOf()
    network.debuggerConnected(socket)
    served(network)
    const { say, close } = report(network)
    await sleep(0)
    requestOf(say, 1)
    say({ type: 'request', id: 2, url: 'https://api.example/slow', method: 'GET', headers: {}, time: 2, wallTime: 1_700_000_000 })
    socket.close()
    const devtools = served(network, { id: 'phone' })
    await sleep(0)
    devtools.fromDebugger({ id: 9, method: 'Network.getResponseBody', params: { requestId: '1.1' } })
    close()
    assert.deepEqual(devtools.toDebugger, [{ id: 9, error: { code: -32_000, message: 'No data found for resource with given identifier' } }])
  })

  it('fails each request an app left going as it goes, and takes nothing it does not know', async () => {
    const network = inspector()
    const devtools = served(network)
    const { say, close } = report(network)
    await sleep(0)
    say({ type: 'request', id: 1, url: 'https://api.example/slow', method: 'GET', headers: {}, time: 2, wallTime: 1_700_000_000 })
    for (const junk of [{ type: 'request', id: 2, url: 1, method: 'GET', time: 2, wallTime: 1 }, { type: 'response', id: 'x', url: '', status: 200, time: 1 }, { type: 'finished', id: 3, time: -1 }, { type: 'nothing', id: 4 }]) say(junk)
    close()
    assert.deepEqual(devtools.toDebugger.map(({ method }) => method), ['Network.requestWillBeSent', 'Network.loadingFailed'])
    assert.deepEqual(devtools.toDebugger[1].params, { requestId: '1.1', timestamp: 2, type: 'XHR', errorText: 'The app went away', canceled: false })
  })

  it("takes no type of a request's events the object's prototype has", async () => {
    const network = inspector()
    const devtools = served(network)
    const { say } = report(network)
    await sleep(0)
    for (const type of ['toString', 'constructor', 'hasOwnProperty', 'valueOf', '__proto__']) say({ type, id: 1, time: 1 })
    assert.deepEqual(devtools.toDebugger, [])
  })
})
