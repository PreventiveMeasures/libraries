// Decides whom the dev server answers: the app, its tools and its own pages, but no other webpage,
// which could otherwise make the browser send it requests. React Native's clients send no
// Sec-Fetch-Site, and as Origin, when they send one, the server's own.

import { BlockList, isIP } from 'node:net'

// A Host is a host and a port alone: no user, path or query.
const HOST = /^[\w.:[\]-]+$/u

const unbracketed = (hostname) => (hostname.startsWith('[') ? hostname.slice(1, -1) : hostname)

// Returns (request) => null if it may be served, else why not.
export function createGate({ hostnames = [] } = {}) {
  const names = new Set(['localhost', ...hostnames.map((name) => name.toLowerCase())])
  return ({ headers, socket }) => {
    const host = typeof headers.host === 'string' && HOST.test(headers.host) ? URL.parse(`http://${headers.host}`) : null
    if (host === null) return 'a request needs a Host'
    // Against DNS rebinding: no page can rebind an IP literal, localhost or the names we were given.
    if (isIP(unbracketed(host.hostname)) === 0 && !names.has(host.hostname)) return `Host ${host.hostname} isn't this server's`
    // Anything but same-origin (a page we served) or none (the user's own navigation).
    const site = headers['sec-fetch-site']
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return `a ${site} request`
    const { origin } = headers
    if (origin === undefined) return null
    const from = URL.parse(origin)
    if (from === null) return `Origin ${origin}`
    return from.protocol === 'http:' && (from.host === host.host || cameInOn(from, host, socket)) ? null : `a request from ${origin}`
  }
}

// Argent sends Origin http://127.0.0.1:8081 to ws://localhost:8081. Fine where that address and port are
// the ones the connection came in on: a page there is this server's. No other loopback address is taken:
// 127.0.0.1, [::1] and 127.0.0.2 on one port may be three servers.
function cameInOn(from, host, { localAddress = '', localPort } = {}) {
  // On a dual-stack socket an IPv4 address is IPv4-mapped (::ffff:127.0.0.1).
  const address = localAddress.replace(/^::ffff:(?=\d+\.)/u, '')
  return host.hostname === 'localhost' && from.port === host.port && Number(from.port || 80) === localPort && isLoopback(address) && unbracketed(from.hostname) === address
}

// BlockList also matches IPv4-mapped IPv6 addresses (::ffff:127.0.0.1) against the IPv4 rule.
const LOOPBACK = new BlockList()
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4')
LOOPBACK.addAddress('::1', 'ipv6')

// Whether a server listening on `host` (--host) is reachable from this machine alone.
export function isLoopback(host) {
  const address = unbracketed(host)
  const type = isIP(address)
  return address.toLowerCase() === 'localhost' || (type !== 0 && LOOPBACK.check(address, `ipv${type}`))
}

// The names, beyond IP literals and localhost, a server on `host` accepts as Host. None on loopback:
// its clients use localhost or an IP, and a name the network resolves could be rebound. Beyond it,
// the machine's own name and its .local (as a device on Wi-Fi uses), and `host` if it's a name.
export function hostnamesOf(host, machine) {
  if (isLoopback(host)) return []
  const name = machine.toLowerCase()
  return [...new Set([name, `${name.replace(/\.local$/u, '')}.local`, ...(isIP(unbracketed(host)) === 0 ? [host.toLowerCase()] : [])])]
}

// On every response. Browsers send Sec-Fetch-Site only to trustworthy origins (localhost, HTTPS) and
// no Origin on a GET of a script, image or page, so on a LAN address a page's <script> or <iframe> of
// ours passes the gate (webpack-dev-server's CVE-2026-6402); these keep the response from that page.
export const SAFE_HEADERS = Object.freeze({
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
})
