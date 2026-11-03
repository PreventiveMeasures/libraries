// The React Native dev server, answering as Metro 0.87's Server and HmrServer do (MIT, Copyright (c)
// Meta Platforms, Inc. and affiliates). Every request passes the gate first; dev-middleware gets what
// isn't ours. Nothing runs a command or opens a file a request names.

import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import { resolve } from 'node:path'

import { bundleRequest, toNormalUrl } from './bundle-url.js'
import { createClientLog } from './client-log.js'
import { SAFE_HEADERS } from './gate.js'
import { hotUpdate } from './hot.js'
import { createNetworkInspector } from './network.js'
import { assetResponse } from './serve-assets.js'
import { servedSourceMap, sourceOfRequest, sourceRoutes } from './source-map.js'
import { bundleUrls, stackOf, symbolicate } from './symbolicate.js'
import { printable } from './terminal.js'
import { acceptWebSocket } from './websocket.js'

const MAX_BODY = 1024 * 1024
const JS = 'application/javascript; charset=UTF-8'
const JSON_TYPE = 'application/json; charset=UTF-8'
const TEXT = 'text/plain; charset=UTF-8'
// RN DevTools fetch source maps and sources from this origin.
const DEVTOOLS = { 'Access-Control-Allow-Origin': 'devtools://devtools' }

// Metro's error JSON, which the app shows: in its red screen for a bundle, in LogBox from /hot.
export async function bundlingError(esbuild, errors, projectRoot) {
  // Strip bundle()'s namespace (metro-polyfill:, ...) off a path.
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

const bundleKey = ({ entryFile, platform, dev, minify }) => [entryFile, platform, dev, minify].join('\0')

// The bundle a URL names, else null.
const bundleOfUrl = (url) => {
  try {
    const parsed = URL.parse(url)
    return parsed === null ? null : bundleRequest(parsed)
  } catch {
    // A path that doesn't decode.
    return null
  }
}

const reply = (request, response, status, body, headers = {}) => {
  const data = typeof body === 'string' ? Buffer.from(body) : body
  response.writeHead(status, { 'Content-Type': TEXT, ...headers, 'Content-Length': String(data.length) })
  response.end(request.method === 'HEAD' ? undefined : data)
}
const replyJson = (request, response, status, value) => reply(request, response, status, JSON.stringify(value), { 'Content-Type': JSON_TYPE })

// The body as text, or null if larger than MAX_BODY.
async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY) {
      request.destroy()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

// Returns { server, broadcast, hotError, hotUpdate, mount, network }; `network` is network.js's
// inspector for DevTools' Network panel. `watchFolders` are the Metro config's, project root first.
// With `clientLogs`, each app's console is logged (client-log.js), its labels styled by `style`.
export function createDevServer({ projectRoot, watchFolders = [projectRoot], esbuild, devBundler, gate, log = () => {}, clientLogs = true, style }) {
  const sources = sourceRoutes(projectRoot, watchFolders)
  // One client log, and so one group state, for all apps, as in Metro.
  const hot = createHot(clientLogs ? createClientLog(log, style) : null)
  const network = createNetworkInspector()
  const rootHeader = new URL(`file:///${projectRoot}`).pathname.slice(1)
  let middleware = null
  let websocketEndpoints = {}
  const messageClients = new Set()
  // Sends `method` (reload, devMenu) to each app; returns how many.
  const broadcast = (method) => {
    const text = JSON.stringify({ version: 2, method })
    for (const client of messageClients) client.send(text)
    return messageClients.size
  }

  const handle = (request, response) => {
    for (const [name, value] of Object.entries(SAFE_HEADERS)) response.setHeader(name, value)
    const answer = (status, body, headers) => reply(request, response, status, body, headers)
    const notFound = () => answer(404, 'rn-serve: not found\n')
    const refusal = gate(request)
    if (refusal !== null) return answer(403, `rn-serve: refused ${refusal}\n`)
    request.url = toNormalUrl(request.url)
    // Resolved against the Host the gate let in, whatever it holds.
    const url = request.url.startsWith('/') ? URL.parse(`http://${request.headers.host}${request.url}`) : null
    if (url === null) return answer(400, 'rn-serve: bad URL\n')
    if (url.pathname === '/status') return answer(200, 'packager-status:running', { 'X-React-Native-Project-Root': rootHeader })
    if (url.pathname === '/reload') {
      broadcast('reload')
      return answer(200, 'OK')
    }
    if (url.pathname === '/symbolicate') return serveSymbolicate(request, response, devBundler)
    if (request.method === 'GET' || request.method === 'HEAD') {
      // The raw path: URL parsing drops the `..` of /assets/../x, an asset outside the project root.
      const rawPath = request.url.split('?')[0]
      if (rawPath.startsWith('/assets/')) {
        const { status, headers, body } = assetResponse(rawPath, { platform: url.searchParams.get('platform'), range: request.headers.range, find: devBundler.asset })
        return answer(status, body, headers)
      }
      const source = sourceOfRequest(url.pathname, sources)
      if (source !== undefined) {
        const data = source === null ? null : devBundler.sourceFile(source)
        return data === null ? notFound() : answer(200, data, DEVTOOLS)
      }
      let bundle
      try {
        bundle = bundleRequest(url)
      } catch {
        return answer(400, 'rn-serve: bad bundle path\n')
      }
      if (bundle !== null) return serveBundle(request, response, bundle, { devBundler, esbuild, projectRoot, sources })
    }
    return middleware === null ? notFound() : middleware(request, response, notFound)
  }

  const server = createServer((request, response) => {
    Promise.try(handle, request, response).catch((error) => {
      log(printable(`rn-serve: ${request.method} ${request.url}: ${error?.stack ?? error}`, { colors: false }))
      if (response.headersSent) response.destroy()
      else reply(request, response, 500, 'rn-serve: internal error\n')
    })
  })
  // A first build may take longer than Node's request timeout.
  server.requestTimeout = 0

  const sockets = {
    '/message': (client) => {
      messageClients.add(client)
      return { onClose: () => messageClients.delete(client) }
    },
    '/hot': hot.connect,
    '/network': network.reporter,
  }
  server.on('upgrade', (request, socket, head) => upgrade(request, socket, head, { gate, sockets, endpoints: websocketEndpoints }))

  return {
    server,
    broadcast,
    hotError: hot.error,
    hotUpdate: hot.update,
    // dev-middleware's { middleware, websocketEndpoints }.
    mount(mounted) {
      ;({ middleware, websocketEndpoints } = mounted)
    },
    network,
  }
}

// Metro's multipart response (MultipartResponse), for clients that take one, as the app's loader does:
// progress parts while building (repeated when quiet, so iOS doesn't time out after 60 s), then the
// bundle, or its error with the status in X-Http-Status. Null if the client takes none.
const BOUNDARY = '3beqjf3apnqeu3h5jqorms4i'
const QUIET = 10_000
function multipart(request, response) {
  if (request.method !== 'GET' || !/\bmultipart\/mixed\b/iu.test(request.headers.accept ?? '')) return null
  response.writeHead(200, { 'Content-Type': `multipart/mixed; boundary="${BOUNDARY}"` })
  response.write('If you are seeing this, your client does not support multipart response')
  const open = () => !response.writableEnded && !response.destroyed
  const part = (headers, body) => {
    if (!open()) return
    response.write(`\r\n--${BOUNDARY}\r\n${Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join('\r\n')}\r\n\r\n`)
    response.write(body)
  }
  let ratio = -1
  let last = null
  const progressed = () => part({ 'Content-Type': 'application/json' }, JSON.stringify(last))
  const quiet = setInterval(() => last !== null && progressed(), QUIET)
  return {
    // Eased as Metro does; sent when the whole percentage grows.
    progress: (done, total) => {
      const eased = Math.min(Math.max((done / Math.max(total, 10)) ** 2, ratio), 0.999)
      last = { done, total, percent: Math.floor(eased * 100) }
      if (last.percent > Math.floor(ratio * 100)) progressed()
      ratio = eased
    },
    end: (status, body, headers) => {
      const data = Buffer.from(body)
      part({ ...(status !== 200 && { 'X-Http-Status': status }), ...headers, 'Content-Length': data.length }, data)
      if (open()) response.end(`\r\n--${BOUNDARY}--\r\n`)
    },
    close: () => clearInterval(quiet),
  }
}

async function serveBundle(request, response, bundle, { devBundler, esbuild, projectRoot, sources }) {
  const parts = bundle.kind === 'bundle' ? multipart(request, response) : null
  const send = (status, body, headers) => (parts === null ? reply(request, response, status, body, headers) : parts.end(status, body, headers))
  const sendJson = (status, value) => send(status, JSON.stringify(value), { 'Content-Type': JSON_TYPE })
  try {
    const outcome = await devBundler.get(bundle, { onProgress: parts?.progress ?? null })
    if (outcome === null) return sendJson(404, { type: 'NotFoundError', message: `rn-serve: the project has no entry ${bundle.entryFile}`, errors: [] })
    if (!outcome.ok) return sendJson(500, await bundlingError(esbuild, outcome.errors, projectRoot))
    if (bundle.kind === 'map') {
      const map = servedSourceMap(outcome.map, { projectRoot, routes: sources, urlServer: bundle.sourcePaths === 'url-server', excludeSource: bundle.excludeSource })
      return send(200, map, { 'Content-Type': JSON_TYPE, ...DEVTOOLS })
    }
    return send(200, `${outcome.js}//# sourceMappingURL=${bundle.sourceMapUrl}\n//# sourceURL=${bundle.sourceUrl}\n`, { 'Content-Type': JS })
  } finally {
    parts?.close()
  }
}

// A WebSocket the gate lets through: ours, else an endpoint's, else none.
function upgrade(request, socket, head, { gate, sockets, endpoints }) {
  socket.on('error', () => {})
  if (gate(request) !== null) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    return
  }
  const pathname = URL.parse(request.url, 'http://localhost')?.pathname
  if (Object.hasOwn(sockets, pathname)) {
    // Frames in `head` arrive before the socket's handlers are known.
    const handlers = {}
    const client = acceptWebSocket(request, socket, head, { onMessage: (text) => handlers.onMessage?.(text), onClose: () => handlers.onClose?.() })
    if (client !== null) Object.assign(handlers, sockets[pathname](client))
  } else if (Object.hasOwn(endpoints, pathname)) {
    endpoints[pathname].handleUpgrade(request, socket, head, (ws) => endpoints[pathname].emit('connection', ws, request))
  } else {
    socket.destroy()
  }
}

// Fast Refresh over /hot, as Metro's HmrServer: each HMRClient, with the bundles it registered
// (bundle key -> the URL it named it by).
function createHot(clientLog) {
  const clients = new Map()
  const sendAll = (client, messages) => {
    for (const message of messages) client.send(JSON.stringify(message))
  }
  const connect = (client) => {
    const bundles = new Map()
    const register = (url) => {
      if (typeof url !== 'string') return
      const normal = toNormalUrl(url)
      const bundle = bundleOfUrl(normal)
      if (bundle !== null) bundles.set(bundleKey(bundle), normal)
    }
    // The bundle its own URL names (?bundleEntry=index.bundle&platform=ios), on the Host it used.
    const query = new URL(client.request.url, 'http://localhost').searchParams
    register(`http://${client.request.headers.host}/${query.get('bundleEntry') ?? ''}?platform=${encodeURIComponent(query.get('platform') ?? '')}`)
    clients.set(client, bundles)
    const onMessage = (text) => {
      let data
      try {
        data = JSON.parse(text)
      } catch {
        return
      }
      if (data?.type === 'register-entrypoints') {
        if (Array.isArray(data.entryPoints)) data.entryPoints.forEach(register)
        // An empty initial update (the app has the latest build) tells HMRClient it's connected.
        sendAll(client, [{ type: 'update-start', body: { isInitialUpdate: true } }, { type: 'update-done', body: {} }, { type: 'bundle-registered' }])
      } else if (data?.type === 'heartbeat') {
        client.send(text)
      } else if (data?.type === 'log' && clientLog !== null) {
        clientLog(data.level, data.mode, data.data)
      }
    }
    return { onMessage, onClose: () => clients.delete(client) }
  }
  // To each app of a bundle among `requests`, and to each that registered none.
  const error = (body, requests) => {
    const text = JSON.stringify({ type: 'error', body })
    const failed = new Set(requests.map(bundleKey))
    for (const [client, bundles] of clients) {
      if (bundles.size === 0 || bundles.keys().some((key) => failed.has(key))) client.send(text)
    }
  }
  // Sends each app of the bundle what changed; with `recovered`, even if nothing did, since an app
  // shows a build error until an update. Returns how many apps it went to.
  const update = (request, before, after, { recovered } = {}) => {
    const key = bundleKey(request)
    let sent = 0
    for (const [client, bundles] of clients) {
      const url = bundles.get(key)
      const body = url === undefined ? null : hotUpdate(before, after, url, { always: recovered })
      if (body === null) continue
      sendAll(client, [{ type: 'update-start', body: { isInitialUpdate: false } }, { type: 'update', body }, { type: 'update-done', body: {} }])
      sent++
    }
    return sent
  }
  return { connect, error, update }
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
    const bundle = bundleOfUrl(file)
    const outcome = bundle === null ? null : await devBundler.get(bundle)
    if (outcome?.ok) maps.set(file, outcome.index())
  }
  return replyJson(request, response, 200, symbolicate(stack, maps, devBundler.readSource))
}
