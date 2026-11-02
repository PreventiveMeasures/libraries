// React Native DevTools opened for each app as it connects (rn-serve's
// --dev-tools, rn.config.json's devTools), as `j` opens them: of the app's
// device, once its runtime lists a page DevTools debugs, unless a DevTools
// is connected to that device already (one left open as the app relaunched,
// which dev-middleware connects to it anew). Once of each connection of a
// device: DevTools closed, they are opened again as the app connects anew.

// A page DevTools debug, as dev-middleware's /open-debugger takes them: one
// that reloads in place (React Native's modern runtime); else, of a runtime
// before it, one whose title names React, as dev-middleware's Device finds
// it, of which it makes the page /open-debugger takes ("React Native
// Experimental (Improved Chrome Reloads)", which no runtime lists itself).
const debuggable = (page) => page?.capabilities?.nativePageReloads === true || (typeof page?.title === 'string' && page.title.includes('React'))

// The device an inspector socket is of, as its URL names it; null where it
// names none (dev-middleware numbers it then).
const deviceOf = (request) => (URL.canParse(request.url, 'http://localhost') ? new URL(request.url, 'http://localhost').searchParams.get('device') || null : null)

// -> { deviceConnected(socket, request), debuggerConnected(socket, request) },
// listeners of dev-middleware's /inspector/device and /inspector/debug, of
// each `ws` socket as it connects. `open(device)` opens DevTools of the
// device (its id; null, the app last connected).
export function createDevToolsOpener(open) {
  // Of each device, how many DevTools are connected to it.
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
        // Once dev-middleware has the pages, of this message too, which its
        // own listener reads after this one.
        setImmediate(() => {
          if (!debuggers.has(device)) open(device)
        })
      }
      socket.on('message', listener)
    },
  }
}
