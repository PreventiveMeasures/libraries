// Whom the dev server answers: the app, the tools beside it, and pages it
// serves itself, but no other webpage. A webpage can make a browser send
// requests anywhere, the dev server's address too:
// - by its own origin, which the browser names in Origin, and in
//   Sec-Fetch-Site for a fetch, a script, an image or a WebSocket, as any
//   but same-origin (a page the server served) or none (the user's own
//   navigation): refused;
// - by DNS rebinding, a name of the page's own pointed at the server, which
//   the browser names in Host: refused but for IP literals, which no page can
//   rebind, localhost, and the names the server is told (the machine's own,
//   where it listens beyond loopback: hostnamesOf()).
// React Native's own clients send no Sec-Fetch-Site, and as Origin, where
// they send one, the server's.
// A browser sends Sec-Fetch-Site only to a potentially trustworthy origin
// (localhost, 127.0.0.1, ::1, HTTPS), and no Origin on a GET of a script, an
// image or a page: to the server at a LAN address (--host=0.0.0.0), a page's
// <script> of a bundle, or <iframe> of a page, comes in as the app's requests
// do (webpack-dev-server's CVE-2026-6402). SAFE_HEADERS have the browser keep
// what it gets from the page then.

import { BlockList, isIP } from 'node:net'

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

// IPv4-mapped IPv6 addresses (::ffff:127.0.0.1) of the IPv4 rule, as BlockList has them.
const LOOPBACK = new BlockList()
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4')
LOOPBACK.addAddress('::1', 'ipv6')

// Whether a server listening on `host` (--host) is of this machine alone:
// on localhost, or a loopback address.
export function isLoopback(host) {
  const address = unbracketed(host)
  const type = isIP(address)
  return address.toLowerCase() === 'localhost' || (type !== 0 && LOOPBACK.check(address, type === 4 ? 'ipv4' : 'ipv6'))
}

// The names a server listening on `host` takes as a Host, beyond IP
// literals and localhost: on loopback, none, as each client it has there (a
// simulator, an emulator, a device over adb reverse) names it by localhost
// or an IP, and a name the network answers for (a bare one through its DNS
// search domains, one DHCP gave the machine, a .local over mDNS) is one
// whoever answers could rebind; else the machine's own (`machine`,
// os.hostname()'s, and its .local), as a device on Wi-Fi names it, and
// `host`, where a name.
export function hostnamesOf(host, machine) {
  if (isLoopback(host)) return []
  const name = machine.toLowerCase()
  return [...new Set([name, `${name.replace(/\.local$/u, '')}.local`, ...(isIP(unbracketed(host)) === 0 ? [host.toLowerCase()] : [])])]
}

// On every response: no other origin may load it, frame it, or sniff it as
// another type than it is.
export const SAFE_HEADERS = Object.freeze({
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
})
