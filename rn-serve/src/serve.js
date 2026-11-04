// The React Native dev server, answering as Metro 0.87's Server and HmrServer do (MIT, Copyright (c)
// Meta Platforms, Inc. and affiliates). Every request passes the gate first; dev-middleware gets what
// isn't ours. Nothing runs a command or opens a file a request names.

import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import { extname, join, posix, resolve } from 'node:path'

import { assetRecord, parseAssetPath } from '@preventive/rn/src/assets.js'
import { diskHost } from '@preventive/rn/src/defaults.js'
import { bundleRequest, toNormalUrl } from './bundle-url.js'
import { SAFE_HEADERS } from './gate.js'
import { hotUpdate } from './hot.js'
import { createNetworkInspector } from './network.js'
import { servedSourceMap, sourceOfRequest, sourceRoutes } from './source-map.js'
import { bundleUrls, stackOf, symbolicate } from './symbolicate.js'
import { createClientLog, printable } from './terminal.js'
import { acceptWebSocket, serverConnections } from './websocket.js'

const MAX_BODY = 1024 * 1024
const JS = { 'Content-Type': 'application/javascript; charset=UTF-8' }
const JSON_TYPE = { 'Content-Type': 'application/json; charset=UTF-8' }
// RN DevTools fetch source maps and sources from this origin.
const DEVTOOLS = { 'Access-Control-Allow-Origin': 'devtools://devtools' }
const ASSET_TYPES = new Map(Object.entries({
  bmp: 'image/bmp', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', psd: 'image/vnd.adobe.photoshop', svg: 'image/svg+xml', webp: 'image/webp', xml: 'application/xml',
  m4v: 'video/x-m4v', mov: 'video/quicktime', mp4: 'video/mp4', mpeg: 'video/mpeg', mpg: 'video/mpeg', webm: 'video/webm',
  aac: 'audio/aac', aiff: 'audio/aiff', caf: 'audio/x-caf', m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav',
  html: 'text/html; charset=utf-8', pdf: 'application/pdf', yaml: 'application/yaml', yml: 'application/yaml',
  otf: 'font/otf', ttf: 'font/ttf', zip: 'application/zip',
}))

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
  const parsed = URL.parse(url)
  try {
    return parsed === null ? null : bundleRequest(parsed)
  } catch {
    // A path that doesn't decode.
    return null
  }
}

// Answers with `body`, a string or bytes; a HEAD request gets none.
const reply = (response, status, body, headers = {}) => {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=UTF-8', ...headers, 'Content-Length': Buffer.byteLength(body) })
  response.end(response.req.method === 'HEAD' ? undefined : body)
}
const replyJson = (response, status, value) => reply(response, status, JSON.stringify(value), JSON_TYPE)

// Returns { server, broadcast, hotError, hotUpdate, mount, network, close }; `network` is network.js's
// inspector for DevTools' Network panel; close() stops taking requests and ends each connection, each
// app told the server is going away. `watchFolders` are the Metro config's, project root first.
// With `clientLogs`, each app's console is logged (terminal.js), its labels styled by `style`.
export function createDevServer({ projectRoot, watchFolders = [projectRoot], esbuild, devBundler, gate, log = () => {}, clientLogs = true, style }) {
  const sources = sourceRoutes(projectRoot, watchFolders)
  // One client log, and so one group state, for all apps, as in Metro.
  const hot = createHot(clientLogs ? createClientLog(log, style) : () => {})
  const network = createNetworkInspector()
  const rootHeader = new URL(`file:///${projectRoot}`).pathname.slice(1)
  // dev-middleware's { middleware, websocketEndpoints }, once mounted.
  let mounted = { middleware: (request, response, next) => next(), websocketEndpoints: {} }
  const { broadcast, connect: messageConnect } = createMessages()
  const sockets = {
    '/message': messageConnect,
    '/hot': hot.connect,
    '/network': network.reporter,
  }

  const handle = (request, response) => {
    for (const [name, value] of Object.entries(SAFE_HEADERS)) response.setHeader(name, value)
    const notFound = () => reply(response, 404, 'rn-serve: not found\n')
    const refusal = gate(request)
    if (refusal !== null) return reply(response, 403, `rn-serve: refused ${refusal}\n`)
    request.url = toNormalUrl(request.url)
    // Resolved against the Host the gate let in, whatever it holds.
    const url = request.url.startsWith('/') ? URL.parse(`http://${request.headers.host}${request.url}`) : null
    if (url === null) return reply(response, 400, 'rn-serve: bad URL\n')
    if (url.pathname === '/status') return reply(response, 200, 'packager-status:running', { 'X-React-Native-Project-Root': rootHeader })
    if (url.pathname === '/reload') {
      // As `r`: the apps reloaded, of the bundles as built.
      broadcast('reload')
      return reply(response, 200, 'OK')
    }
    if (url.pathname === '/symbolicate') return serveSymbolicate(request, response, devBundler)
    if (request.method === 'GET' || request.method === 'HEAD') {
      // The raw path: URL parsing drops the `..` of /assets/../x, an asset outside the project root.
      const rawPath = request.url.split('?')[0]
      if (rawPath.startsWith('/assets/')) return serveAsset(request, response, rawPath, url.searchParams.get('platform'), devBundler)
      const source = sourceOfRequest(url.pathname, sources)
      if (source !== undefined) {
        const data = source === null ? null : devBundler.sourceFile(source)
        return data === null ? notFound() : reply(response, 200, data, DEVTOOLS)
      }
      let bundle
      try {
        bundle = bundleRequest(url)
      } catch {
        return reply(response, 400, 'rn-serve: bad bundle path\n')
      }
      if (bundle !== null) return serveBundle(request, response, bundle, { devBundler, esbuild, projectRoot, sources })
    }
    return mounted.middleware(request, response, notFound)
  }

  // A first build may take longer than Node's request timeout.
  const server = createServer({ requestTimeout: 0 }, (request, response) => {
    Promise.try(handle, request, response).catch((error) => {
      log(printable(`rn-serve: ${request.method} ${request.url}: ${error?.stack ?? error}`, { colors: false }))
      if (response.headersSent) response.destroy()
      else reply(response, 500, 'rn-serve: internal error\n')
    })
  })
  const connections = serverConnections(server)
  // A WebSocket the gate lets through: ours, else an endpoint's, else none.
  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => {})
    const pathname = URL.parse(request.url, 'http://localhost')?.pathname
    const endpoints = mounted.websocketEndpoints
    if (gate(request) !== null) socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    else if (Object.hasOwn(sockets, pathname)) acceptWebSocket(request, socket, head, connections.accepting(sockets[pathname]))
    else if (Object.hasOwn(endpoints, pathname)) endpoints[pathname].handleUpgrade(request, connections.adopt(socket), head, (ws) => endpoints[pathname].emit('connection', ws, request))
    else socket.destroy()
  })

  return {
    server,
    broadcast,
    hotError: hot.error,
    hotUpdate: hot.update,
    mount(devMiddleware) {
      mounted = devMiddleware
    },
    network,
    close: connections.close,
  }
}

// Metro's multipart response (MultipartResponse), for clients that take one, as the app's loader does:
// progress parts while building (repeated when quiet, so iOS doesn't time out after 60 s), then the
// bundle, or its error with the status in X-Http-Status.
const BOUNDARY = '3beqjf3apnqeu3h5jqorms4i'
const QUIET = 10_000
function multipart(response) {
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
  const quiet = setInterval(() => {
    if (last !== null) progressed()
  }, QUIET)
  response.once('close', () => clearInterval(quiet))
  return {
    // Eased as Metro does; sent when the whole percentage grows.
    progress: (done, total) => {
      const eased = Math.min(Math.max((done / Math.max(total, 10)) ** 2, ratio), 0.999)
      last = { done, total, percent: Math.floor(eased * 100) }
      if (last.percent > Math.floor(ratio * 100)) progressed()
      ratio = eased
    },
    end: (status, body, headers) => {
      part({ ...(status !== 200 && { 'X-Http-Status': status }), ...headers, 'Content-Length': Buffer.byteLength(body) }, body)
      if (open()) response.end(`\r\n--${BOUNDARY}--\r\n`)
    },
  }
}

async function serveBundle(request, response, bundle, { devBundler, esbuild, projectRoot, sources }) {
  const parts = bundle.kind === 'bundle' && request.method === 'GET' && /\bmultipart\/mixed\b/iu.test(request.headers.accept ?? '') ? multipart(response) : null
  const send = parts?.end ?? ((status, body, headers) => reply(response, status, body, headers))
  const outcome = await devBundler.get(bundle, { onProgress: parts?.progress })
  if (outcome === null) return send(404, JSON.stringify({ type: 'NotFoundError', message: `rn-serve: the project has no entry ${bundle.entryFile}`, errors: [] }), JSON_TYPE)
  if (!outcome.ok) return send(500, JSON.stringify(await bundlingError(esbuild, outcome.errors, projectRoot)), JSON_TYPE)
  if (bundle.kind === 'map') {
    const map = servedSourceMap(outcome.map, { projectRoot, routes: sources, urlServer: bundle.sourcePaths === 'url-server', excludeSource: bundle.excludeSource })
    return send(200, map, { ...JSON_TYPE, ...DEVTOOLS })
  }
  return send(200, `${outcome.js}//# sourceMappingURL=${bundle.sourceMapUrl}\n//# sourceURL=${bundle.sourceUrl}\n`, JS)
}

// GET /assets/<path>@<scale>x.<type>?platform= as Metro answers it (Server._processSingleAssetRequest),
// but only for assets of bundles it built: the scale asked for, else the next up, else the largest; and
// byte ranges, as AVPlayer asks. `rawPath` keeps its `..` segments, as assetData's httpServerLocation does.
function serveAsset(request, response, rawPath, platform, devBundler) {
  const missing = () => reply(response, 404, 'rn-serve: no such asset in a bundle served\n')
  let rel
  try {
    rel = decodeURIComponent(rawPath.slice('/assets/'.length))
  } catch {
    return reply(response, 400, 'rn-serve: bad asset path\n')
  }
  const asked = parseAssetPath(rel, platform)
  const dir = posix.dirname(rel)
  const data = asked === null ? null : devBundler.asset(dir.startsWith('..') ? `/assets/${dir}` : posix.join('/assets', dir), asked.name, asked.type)
  if (data === null) return missing()
  let file
  let bytes
  try {
    const { files, scales } = assetRecord(join(data.fileSystemLocation, `${data.name}.${data.type}`), { platform, host: diskHost })
    // The first scale at least as large as asked, else (-1) the largest.
    file = files.at(scales.findIndex((scale) => scale >= asked.resolution))
    bytes = diskHost.readFile(file)
  } catch {
    // Gone since the build.
    return missing()
  }
  const headers = { 'Content-Type': ASSET_TYPES.get(extname(file).slice(1).toLowerCase()) ?? 'application/octet-stream', 'Accept-Ranges': 'bytes' }
  const [, from = '', to = ''] = /^bytes=(\d*)-(\d*)$/u.exec(request.headers.range ?? '') ?? []
  if (from === '' && to === '') return reply(response, 200, bytes, headers)
  const size = bytes.length
  const start = from === '' ? Math.max(size - Number(to), 0) : Number(from)
  const end = from === '' || to === '' ? size - 1 : Math.min(Number(to), size - 1)
  if (start > end || start >= size) return reply(response, 416, '', { ...headers, 'Content-Range': `bytes */${size}` })
  return reply(response, 206, bytes.subarray(start, end + 1), { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}` })
}

// The apps of /message: connect(client), and broadcast(method), which sends `method` (reload, devMenu)
// to each app and returns how many.
function createMessages() {
  const clients = new Set()
  return {
    connect: (client) => {
      clients.add(client)
      return { onMessage: () => {}, onClose: () => clients.delete(client) }
    },
    broadcast: (method) => {
      const text = JSON.stringify({ version: 2, method })
      for (const client of clients) client.send(text)
      return clients.size
    },
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
      } else if (data?.type === 'log') {
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
  if (request.method !== 'POST') return reply(response, 405, 'rn-serve: POST a stack\n', { Allow: 'POST' })
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY) {
      request.destroy()
      return replyJson(response, 413, { error: 'Request body too large' })
    }
    chunks.push(chunk)
  }
  let stack
  try {
    stack = stackOf(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  } catch (error) {
    return replyJson(response, 400, { error: error.message })
  }
  const maps = new Map()
  for (const file of bundleUrls(stack)) {
    const bundle = bundleOfUrl(file)
    const outcome = bundle === null ? null : await devBundler.get(bundle)
    if (outcome?.ok) maps.set(file, outcome.index())
  }
  return replyJson(response, 200, symbolicate(stack, maps, devBundler.readSource))
}
