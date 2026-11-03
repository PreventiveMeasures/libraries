// POST /symbolicate as Metro 0.87 answers LogBox (Server._symbolicate; MIT, Copyright (c) Meta
// Platforms, Inc. and affiliates): frames mapped to their sources, React Native's own collapsed as
// @react-native/metro-config's customizeFrame does, and a code frame of the first frame left.

const INTERNAL_CALLSITES = new RegExp([
  '/Libraries/BatchedBridge/MessageQueue\\.js$',
  '/Libraries/Core/.+\\.js$',
  '/Libraries/LogBox/.+\\.js$',
  '/Libraries/Network/.+\\.js$',
  '/Libraries/Pressability/.+\\.js$',
  '/Libraries/Renderer/implementations/.+\\.js$',
  '/Libraries/Utilities/.+\\.js$',
  '/Libraries/vendor/.+\\.js$',
  '/Libraries/WebSocket/.+\\.js$',
  '/src/private/renderer/errorhandling/.+\\.js$',
  '/metro-runtime/.+\\.js$',
  '/node_modules/@babel/runtime/.+\\.js$',
  '/node_modules/@react-native/js-polyfills/.+\\.js$',
  '/node_modules/invariant/.+\\.js$',
  '/node_modules/react-devtools-core/.+\\.js$',
  '/node_modules/react-native/index.js$',
  '/node_modules/react-refresh/.+\\.js$',
  '/node_modules/scheduler/.+\\.js$',
  '^\\[native code\\]$',
].map((pattern) => pattern.replaceAll('/', '[/\\\\]')).join('|'), 'u')
const NEWLINE = /\r\n|[\n\r\u2028\u2029]/u
const FIELDS = [['file', 'string'], ['methodName', 'string'], ['lineNumber', 'number'], ['column', 'number']]

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// The stack of a request body, as Metro validates it; throws a TypeError if bad.
// `normalUrl` undoes a JSC-safe URL.
export function stackOf(body, normalUrl) {
  if (!isObject(body) || !Array.isArray(body.stack)) throw new TypeError(`Bad symbolication input, expected object with stack array, got: ${JSON.stringify(body)}`)
  return body.stack.map((frame, at) => {
    if (!isObject(frame)) throw new TypeError(`Bad frame at line ${at}: Expected frame to be a JSON object`)
    const bad = FIELDS.find(([name, type]) => frame[name] != null && typeof frame[name] !== type)
    if (bad !== undefined) throw new TypeError(`Bad frame at line ${at}: Expected ${bad[0]} to be ${bad[1]} or nullish`)
    return { ...frame, file: typeof frame.file === 'string' && frame.file.includes('://') ? normalUrl(frame.file) : frame.file }
  })
}

export const bundleUrls = (stack) => new Set(stack.map(({ file }) => file).filter((file) => typeof file === 'string' && file.startsWith('http') && !file.endsWith('/debuggerWorker.js')))

// `maps`: Map<bundle URL, { originalPositionFor(line1, column0), sources }>; `readSource(path)`
// returns the text of a source the server built from, else null.
export function symbolicate(stack, maps, readSource) {
  const symbolicated = stack.map((frame) => {
    const map = maps.get(frame.file)
    const position = map === undefined || frame.lineNumber == null || frame.column == null ? null : map.originalPositionFor(frame.lineNumber, frame.column)
    const file = position === null ? undefined : map.sources[position.source]
    const out = file === undefined ? frame : { ...frame, file, lineNumber: position.line1, column: position.column0 }
    return { ...out, collapse: out.file != null && INTERNAL_CALLSITES.test(out.file) }
  })
  return { codeFrame: codeFrame(symbolicated, maps, readSource), stack: symbolicated }
}

// Of the first frame not collapsed (any, if all are) in a source we have.
function codeFrame(stack, maps, readSource) {
  const allCollapsed = stack.every(({ collapse }) => collapse)
  for (const { collapse, column, file, lineNumber } of stack) {
    if ((collapse && !allCollapsed) || lineNumber == null || file == null || maps.has(file)) continue
    const source = readSource(file)
    if (source !== null) return { content: drawCodeFrame(source, lineNumber, column), location: { row: lineNumber, column }, fileName: file }
  }
  return null
}

// @babel/code-frame's codeFrameColumns, uncolored, two lines above and three below.
export function drawCodeFrame(source, line1, column0) {
  const lines = source.split(NEWLINE)
  const start = Math.max(line1 - 3, 0)
  const end = Math.min(lines.length, line1 + 3)
  const width = String(end).length
  return lines.slice(start, end).map((text, i) => {
    const number = start + 1 + i
    const gutter = `${String(number).padStart(width)} |`
    const line = text.length > 0 ? ` ${text}` : ''
    if (number !== line1) return ` ${gutter}${line}`
    const caret = column0 == null ? '' : `\n ${gutter.replaceAll(/\d/gu, ' ')} ${text.slice(0, column0).replaceAll(/[^\t]/gu, ' ')}^`
    return `>${gutter}${line}${caret}`
  }).join('\n')
}
