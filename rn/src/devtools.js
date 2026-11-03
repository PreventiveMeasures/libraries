// Opens React Native DevTools for each app as it connects (--devtools), as `j` does: once its
// runtime lists a debuggable page, unless DevTools are already connected to that device (one left
// open across a relaunch, which dev-middleware reconnects). Once per device connection.

// What dev-middleware's /open-debugger can debug: a page that reloads in place (the modern runtime),
// else one whose title names React, from which dev-middleware's Device makes its own page.
const debuggable = (page) => page?.capabilities?.nativePageReloads === true || (typeof page?.title === 'string' && page.title.includes('React'))

// The device an inspector socket's URL names; null if none (dev-middleware numbers it then).
const deviceOf = (request) => URL.parse(request.url, 'http://localhost')?.searchParams.get('device') || null

// Listeners for each `ws` socket of dev-middleware's /inspector/device and /inspector/debug.
// `open(device)` opens DevTools for the device (null: the app that connected last).
export function createDevToolsOpener(open) {
  // How many DevTools are connected to each device.
  const debuggers = new Map()
  return {
    debuggerConnected(socket, request) {
      const device = deviceOf(request)
      debuggers.set(device, (debuggers.get(device) ?? 0) + 1)
      socket.once('close', () => {
        const left = debuggers.get(device) - 1
        if (left === 0) debuggers.delete(device)
        else debuggers.set(device, left)
      })
    },
    deviceConnected(socket, request) {
      const device = deviceOf(request)
      const listener = (data) => {
        let message
        try {
          message = JSON.parse(String(data))
        } catch {
          return
        }
        if (message?.event !== 'getPages' || !Array.isArray(message.payload) || !message.payload.some(debuggable)) return
        socket.off('message', listener)
        // Wait for dev-middleware's own listener, which runs after ours, to take in the pages.
        setImmediate(() => {
          if (!debuggers.has(device)) open(device)
        })
      }
      socket.on('message', listener)
    },
  }
}
