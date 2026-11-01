// A React Native dev server, as the app and its tools talk to Metro's (Metro
// 0.87's Server and HmrServer, @react-native-community/cli-server-api; MIT,
// Copyright (c) Meta Platforms, Inc. and affiliates). Each request passes
// the gate first. HTTP:
//   /status                    packager-status:running
//   /<entry>.bundle?platform=  the bundle, its sourceMappingURL and sourceURL
//   /<entry>.map?platform=     its source map
//   /assets/<path>?platform=   an asset of a bundle served
//   POST /symbolicate          LogBox's stack frames, at their sources
//   /reload                    reload each app
// and anything else to `middleware` (@react-native/dev-middleware's), if any.
// WebSockets:
//   /message                   reload and devMenu, to each app
//   /hot                       each app's HMRClient: never an update, only
//                              build errors; a change reloads instead
// and `websocketEndpoints`, `ws` servers (dev-middleware's inspector).
// Nothing runs a command or opens a file a request names.

import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import { resolve } from 'node:path'

import { bundleRequest, toNormalUrl } from './bundle-url.js'
import { diskHost } from './defaults.js'
import { SAFE_HEADERS } from './gate.js'
import { assetResponse } from './serve-assets.js'
import { bundleUrls, stackOf, symbolicate } from './symbolicate.js'
import { acceptWebSocket } from './websocket.js'

const MAX_BODY = 1024 * 1024
const JS = 'application/javascript; charset=UTF-8'
const JSON_TYPE = 'application/json; charset=UTF-8'
const TEXT = 'text/plain; charset=UTF-8'

// Metro's error JSON, which the app shows: in its red screen for a bundle,
// in LogBox from /hot.
export async function bundlingError(esbuild, errors, projectRoot) {
  // A path in a namespace of bundle()'s is a path too.
  const at = (location) => ({ filename: resolve(projectRoot, location.file.replace(/^metro-[a-z]+:/u, '')), lineNumber: location.line })
  const located = errors.find(({ location }) => location)
  const message = (await esbuild.formatMessages(errors, { kind: 'error', color: false })).join('').trim()
  return {
    type: 'TransformError',
    message,
    errors: errors.map(({ text, location }) => ({ description: text, ...(location && at(location)) })),
    ...(located && { ...at(located.location), column: located.location.column }),
  }
}

const reply = (request, response, status, body, headers = {}) => {
  const data = typeof body === 'string' ? Buffer.from(body) : body
  response.writeHead(status, { 'Content-Type': TEXT, ...headers, 'Content-Length': String(data.length) })
  response.end(request.method === 'HEAD' ? undefined : data)
}
const replyJson = (request, response, status, value) => reply(request, response, status, JSON.stringify(value), { 'Content-Type': JSON_TYPE })

function readBody(request) {
  return new Promise((done, fail) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        request.destroy()
        done(null)
      } else {
        chunks.push(chunk)
      }
    })
    request.on('end', () => done(Buffer.concat(chunks).toString('utf8')))
    request.on('error', fail)
  })
}

// -> { server, broadcast(method), hotError(error), mount({ middleware,
// websocketEndpoints }), clients() }
export function createDevServer({ projectRoot, esbuild, devBundler, gate, host = diskHost, log = () => {}, clientLogs = false }) {
  let middleware = null
  let websocketEndpoints = {}
  const messageClients = new Set()
  const hotClients = new Set()
  const broadcast = (method) => {
    const text = JSON.stringify({ version: 2, method })
    for (const client of messageClients) client.send(text)
    return messageClients.size
  }
  const hotError = (body) => {
    const text = JSON.stringify({ type: 'error', body })
    for (const client of hotClients) client.send(text)
  }

  const routes = {
    '/status': (request, response) => reply(request, response, 200, 'packager-status:running', { 'X-React-Native-Project-Root': new URL(`file:///${projectRoot}`).pathname.slice(1) }),
    '/reload': (request, response) => {
      broadcast('reload')
      reply(request, response, 200, 'OK')
    },
    '/symbolicate': (request, response) => serveSymbolicate(request, response, devBundler),
  }

  const handle = (request, response) => {
    for (const [name, value] of Object.entries(SAFE_HEADERS)) response.setHeader(name, value)
    const refusal = gate(request)
    if (refusal !== null) return reply(request, response, 403, `rn-serve: refused ${refusal}\n`)
    request.url = toNormalUrl(request.url)
    // A path, as clients send: its origin the Host the gate let in, whatever it holds.
    const url = request.url.startsWith('/') && URL.canParse(`http://${request.headers.host}${request.url}`) ? new URL(`http://${request.headers.host}${request.url}`) : null
    if (url === null) return reply(request, response, 400, 'rn-serve: bad URL\n')
    if (Object.hasOwn(routes, url.pathname)) return routes[url.pathname](request, response)
    const read = request.method === 'GET' || request.method === 'HEAD'
    if (read && url.pathname.startsWith('/assets/')) {
      const { status, headers, body } = assetResponse(request.url.split('?')[0], { platform: url.searchParams.get('platform'), range: request.headers.range, find: devBundler.asset, host })
      return reply(request, response, status, body, headers)
    }
    let bundle
    try {
      bundle = read ? bundleRequest(url) : null
    } catch {
      return reply(request, response, 400, 'rn-serve: bad bundle path\n')
    }
    if (bundle !== null) return serveBundle(request, response, bundle, { devBundler, esbuild, projectRoot })
    if (middleware !== null) return middleware(request, response, () => reply(request, response, 404, 'rn-serve: not found\n'))
    return reply(request, response, 404, 'rn-serve: not found\n')
  }

  const server = createServer((request, response) => {
    Promise.resolve().then(() => handle(request, response)).catch((error) => {
      log(`rn-serve: ${request.method} ${request.url}: ${error?.stack ?? error}`)
      if (response.headersSent) response.destroy()
      else reply(request, response, 500, 'rn-serve: internal error\n')
    })
  })
  // A first build may take longer than Node's timeouts.
  server.requestTimeout = 0
  server.timeout = 0

  const sockets = {
    '/message': (client) => {
      messageClients.add(client)
      return { onClose: () => messageClients.delete(client) }
    },
    '/hot': (client) => {
      hotClients.add(client)
      return { onMessage: (text) => onHotMessage(client, text, { log, clientLogs }), onClose: () => hotClients.delete(client) }
    },
  }
  server.on('upgrade', (request, socket, head) => upgrade(request, socket, head, { gate, sockets, endpoints: websocketEndpoints }))

  const mount = (mounted) => {
    ;({ middleware, websocketEndpoints } = mounted)
  }
  return { server, broadcast, hotError, mount, clients: () => ({ message: messageClients.size, hot: hotClients.size }) }
}

async function serveBundle(request, response, bundle, { devBundler, esbuild, projectRoot }) {
  const outcome = await devBundler.get(bundle)
  if (outcome === null) return replyJson(request, response, 404, { type: 'NotFoundError', message: `rn-serve: the project has no entry ${bundle.entryFile}`, errors: [] })
  if (!outcome.ok) return replyJson(request, response, 500, await bundlingError(esbuild, outcome.errors, projectRoot))
  // Chrome DevTools may need the source map.
  if (bundle.kind === 'map') return reply(request, response, 200, outcome.map, { 'Content-Type': JSON_TYPE, 'Access-Control-Allow-Origin': 'devtools://devtools' })
  return reply(request, response, 200, `${outcome.js}//# sourceMappingURL=${bundle.sourceMapUrl}\n//# sourceURL=${bundle.sourceUrl}\n`, { 'Content-Type': JS })
}

// A WebSocket the gate lets through: ours, else an endpoint's, else none.
function upgrade(request, socket, head, { gate, sockets, endpoints }) {
  socket.on('error', () => {})
  if (gate(request) !== null) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    return
  }
  const { pathname } = URL.canParse(request.url, 'http://localhost') ? new URL(request.url, 'http://localhost') : {}
  if (Object.hasOwn(sockets, pathname)) {
    const handlers = {}
    const client = acceptWebSocket(request, socket, head, { onMessage: (text) => handlers.onMessage?.(text), onClose: () => handlers.onClose?.() })
    if (client !== null) Object.assign(handlers, sockets[pathname](client))
  } else if (Object.hasOwn(endpoints, pathname)) {
    endpoints[pathname].handleUpgrade(request, socket, head, (ws) => endpoints[pathname].emit('connection', ws, request))
  } else {
    socket.destroy()
  }
}

// HMRClient's messages, as Metro's HmrServer answers them but for updates:
// an initial update of nothing, which tells it it's connected.
function onHotMessage(client, text, { log, clientLogs }) {
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return
  }
  if (data?.type === 'register-entrypoints') {
    for (const message of [{ type: 'update-start', body: { isInitialUpdate: true } }, { type: 'update-done', body: {} }, { type: 'bundle-registered' }]) client.send(JSON.stringify(message))
  } else if (data?.type === 'heartbeat') {
    client.send(text)
  } else if (data?.type === 'log' && clientLogs && Array.isArray(data.data)) {
    log(`${String(data.level).toUpperCase()} ${data.data.map(String).join(' ')}`)
  }
}

async function serveSymbolicate(request, response, devBundler) {
  if (request.method !== 'POST') return reply(request, response, 405, 'rn-serve: POST a stack\n', { Allow: 'POST' })
  const body = await readBody(request)
  if (body === null) return replyJson(request, response, 413, { error: 'Request body too large' })
  let stack
  try {
    stack = stackOf(JSON.parse(body), toNormalUrl)
  } catch (error) {
    return replyJson(request, response, 400, { error: error.message })
  }
  const maps = new Map()
  for (const file of bundleUrls(stack)) {
    let bundle = null
    try {
      bundle = URL.canParse(file) ? bundleRequest(new URL(file)) : null
    } catch {
      // A path that doesn't decode: no bundle of ours.
    }
    const outcome = bundle === null ? null : await devBundler.get(bundle)
    if (outcome?.ok) maps.set(file, outcome.index())
  }
  return replyJson(request, response, 200, symbolicate(stack, maps, devBundler.readSource))
}
