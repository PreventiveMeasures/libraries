// Whom the dev server answers: the app, the tools beside it, and pages it
// serves itself, but no other webpage. A webpage can make a browser send
// requests anywhere, the dev server's address too:
// - by its own origin, which the browser names in Origin, and in
//   Sec-Fetch-Site for a fetch, a script, an image or a WebSocket, as any
//   but same-origin (a page the server served) or none (the user's own
//   navigation): refused;
// - by DNS rebinding, a name of the page's own pointed at the server, which
//   the browser names in Host: refused but for IP literals, which no page can
//   rebind, localhost, and the names the server is told (the machine's own).
// React Native's own clients send no Sec-Fetch-Site, and as Origin, where
// they send one, the server's.

import { isIP } from 'node:net'

// A Host is a host and a port alone: no user, path or query.
const HOST = /^[\w.:[\]-]+$/u

const hostOf = (value) => {
  if (!HOST.test(value)) return null
  try {
    return new URL(`http://${value}`)
  } catch {
    return null
  }
}

const unbracketed = (hostname) => (hostname.startsWith('[') ? hostname.slice(1, -1) : hostname)

// -> (request) => null where it may be served, else why not.
export function createGate({ hostnames = [] } = {}) {
  const names = new Set(['localhost', ...hostnames.map((name) => name.toLowerCase())])
  return ({ headers }) => {
    const host = typeof headers.host === 'string' ? hostOf(headers.host) : null
    if (host === null) return 'a request needs a Host'
    if (isIP(unbracketed(host.hostname)) === 0 && !names.has(host.hostname)) return `Host ${host.hostname} isn't this server's`
    const site = headers['sec-fetch-site']
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return `a ${site} request`
    const origin = headers.origin
    if (origin === undefined) return null
    let from
    try {
      from = new URL(origin)
    } catch {
      return `Origin ${origin}`
    }
    return from.protocol === 'http:' && from.host === host.host ? null : `a request from ${origin}`
  }
}

// On every response: no other origin may load it, and none may sniff it as
// another type than it is.
export const SAFE_HEADERS = Object.freeze({
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
})
