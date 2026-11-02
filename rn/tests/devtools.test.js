import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import { setImmediate as tick } from 'node:timers/promises'

import { createDevToolsOpener } from '../src/devtools.js'

// An inspector socket, as dev-middleware's `ws` server has it, of its
// request: `url`, its path.
const connect = (listener, url) => {
  // eslint-disable-next-line unicorn/prefer-event-target -- as `ws` has it, an EventEmitter
  const socket = new EventEmitter()
  listener(socket, { url })
  return socket
}
const pages = (...list) => JSON.stringify({ event: 'getPages', payload: list })
const MODERN = { id: '1', title: 'App (iPhone)', app: 'com.app', capabilities: { nativePageReloads: true } }

describe('createDevToolsOpener', () => {
  const setup = () => {
    const opened = []
    const opener = createDevToolsOpener((device) => opened.push(device))
    return { opened, opener }
  }

  it('opens DevTools of a device once its runtime lists a page they debug, once a connection', async () => {
    const { opened, opener } = setup()
    const device = connect(opener.deviceConnected, '/inspector/device?device=phone&name=iPhone&app=com.app')
    device.emit('message', pages())
    device.emit('message', 'not JSON')
    device.emit('message', JSON.stringify({ event: 'wrappedEvent', payload: {} }))
    await tick()
    assert.deepEqual(opened, [])
    device.emit('message', Buffer.from(pages(MODERN)))
    device.emit('message', pages(MODERN))
    await tick()
    assert.deepEqual(opened, ['phone'])
    // Closed, and the app connecting anew: again.
    connect(opener.deviceConnected, '/inspector/device?device=phone&name=iPhone&app=com.app').emit('message', pages(MODERN))
    await tick()
    assert.deepEqual(opened, ['phone', 'phone'])
  })

  it("takes a runtime's legacy page, as /open-debugger does, and no page of neither", async () => {
    const { opened, opener } = setup()
    connect(opener.deviceConnected, '/inspector/device?device=old').emit('message', pages({ id: '2', title: 'React Native Experimental (Improved Chrome Reloads)', app: 'com.app' }))
    connect(opener.deviceConnected, '/inspector/device?device=jsc').emit('message', pages({ id: '1', title: 'JSC', app: 'com.app', capabilities: {} }))
    await tick()
    assert.deepEqual(opened, ['old'])
  })

  it('opens none where DevTools are connected to the device, as dev-middleware keeps them across a relaunch, until they close', async () => {
    const { opened, opener } = setup()
    const debug = connect(opener.debuggerConnected, '/inspector/debug?device=phone&page=1')
    connect(opener.debuggerConnected, '/inspector/debug?device=tablet&page=1')
    connect(opener.deviceConnected, '/inspector/device?device=phone').emit('message', pages(MODERN))
    await tick()
    assert.deepEqual(opened, [])
    debug.emit('close')
    connect(opener.deviceConnected, '/inspector/device?device=phone').emit('message', pages(MODERN))
    await tick()
    assert.deepEqual(opened, ['phone'])
  })

  it("opens the app last connected's of a device its URL names none of", async () => {
    const { opened, opener } = setup()
    connect(opener.deviceConnected, '/inspector/device').emit('message', pages(MODERN))
    await tick()
    assert.deepEqual(opened, [null])
  })
})
