// POST /symbolicate as Metro 0.87 answers it for LogBox (Server._symbolicate,
// Server/symbolicate; MIT, Copyright (c) Meta Platforms, Inc. and
// affiliates): each frame in a bundle the server built mapped to its source,
// React Native's own frames collapsed as @react-native/metro-config's
// symbolicator.customizeFrame collapses them, and a code frame, as
// @babel/code-frame draws it uncolored, of the first frame left.

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

const isNullish = (value) => value === null || value === undefined
const nullishOr = (type) => (value) => isNullish(value) || typeof value === type

// The stack of a request body, as Metro takes it; throws a TypeError where
// it takes none. `normalUrl` undoes a JSC-safe URL.
export function stackOf(body, normalUrl) {
  if (body === null || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.stack)) throw new TypeError(`Bad symbolication input, expected object with stack array, got: ${JSON.stringify(body)}`)
  return body.stack.map((frame, at) => {
    const why = frameError(frame)
    if (why !== null) throw new TypeError(`Bad frame at line ${at}: ${why}`)
    return { ...frame, file: typeof frame.file === 'string' && frame.file.includes('://') ? normalUrl(frame.file) : frame.file }
  })
}

function frameError(frame) {
  if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) return 'Expected frame to be a JSON object'
  if (!nullishOr('string')(frame.file)) return 'Expected file to be string or nullish'
  if (!nullishOr('string')(frame.methodName)) return 'Expected methodName to be string or nullish'
  if (!nullishOr('number')(frame.lineNumber)) return 'Expected lineNumber to be number or nullish'
  if (!nullishOr('number')(frame.column)) return 'Expected column to be number or nullish'
  return null
}

// The URLs of bundles in a stack.
export const bundleUrls = (stack) => new Set(stack.map(({ file }) => file).filter((file) => typeof file === 'string' && file.startsWith('http') && !file.endsWith('/debuggerWorker.js')))

// `maps`: Map<url, { originalPositionFor(line1, column0), sources: string[] }>
// -> { stack, codeFrame } as Metro answers. `readSource(path)` -> the text
// of a source the server built from, else null.
export function symbolicate(stack, maps, readSource) {
  const symbolicated = stack.map((frame) => {
    const map = maps.get(frame.file)
    const position = map === undefined || isNullish(frame.lineNumber) || isNullish(frame.column) ? null : map.originalPositionFor(frame.lineNumber, frame.column)
    const at = position === null || map.sources[position.source] === undefined ? {} : { file: map.sources[position.source], lineNumber: position.line1, column: position.column0 }
    const out = { ...frame, ...at }
    return { ...out, collapse: !isNullish(out.file) && INTERNAL_CALLSITES.test(out.file) }
  })
  return { codeFrame: codeFrame(symbolicated, new Set(maps.keys()), readSource), stack: symbolicated }
}

function codeFrame(stack, urls, readSource) {
  const allCollapsed = stack.every(({ collapse }) => collapse)
  for (const { collapse, column, file, lineNumber } of stack) {
    if ((!allCollapsed && collapse) || isNullish(lineNumber) || isNullish(file) || urls.has(file)) continue
    const source = readSource(file)
    if (source === null) continue
    return { content: drawCodeFrame(source, lineNumber, column), location: { row: lineNumber, column }, fileName: file }
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
    const caret = isNullish(column0) ? '' : `\n ${gutter.replaceAll(/\d/gu, ' ')} ${text.slice(0, column0).replaceAll(/[^\t]/gu, ' ')}^`
    return `>${gutter}${line}${caret}`
  }).join('\n')
}
