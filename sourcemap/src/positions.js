import { segmentsOf } from './map.js'

// Where in the generated code a parser's offset is, and which file a map
// says that place came from. Offsets and columns both count UTF-16 code
// units, as the parser reports them and as the format defines columns.

// The format leaves line breaks to the generated code's language; these are
// JavaScript's, the ones an engine numbers a stack frame's line by.
const BREAK = /\r\n?|[\n\u2028\u2029]/gu

export function lineStarts(code) {
  const starts = [0]
  for (const match of code.matchAll(BREAK)) starts.push(match.index + match[0].length)
  return starts
}

// The index of the last of sorted `array[lo..hi)` at or before `value`, or
// lo - 1 where there is none.
function lastAtOrBefore(array, lo, hi, value) {
  let found = lo - 1
  let low = lo
  let high = hi - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (array[mid] <= value) {
      found = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return found
}

// [line, column] of `offset`, both from zero.
export function positionOf(starts, offset) {
  const line = lastAtOrBefore(starts, 0, starts.length, offset)
  return [line, offset - starts[line]]
}

// The segment a position falls under, or -1: the last on its line that
// starts at or before it, as a debugger reads a frame.
function segmentAt(segments, [line, column]) {
  if (line >= segments.starts.length - 1) return -1
  const from = segments.starts[line]
  const found = lastAtOrBefore(segments.columns, from, segments.starts[line + 1], column)
  return found < from ? -1 : found
}

// The file the code at `offset` came from, or null where the map says
// nothing or says it came from nowhere.
export function fileAt(map, starts, offset) {
  const segments = segmentsOf(map)
  const found = segmentAt(segments, positionOf(starts, offset))
  return found < 0 || segments.sources[found] < 0 ? null : map.files[segments.sources[found]]
}

// The file most of the segments over [start, end) came from, the one the
// code at `start` falls under among them; null where none came from a file.
export function fileWithin(map, starts, start, end) {
  const segments = segmentsOf(map)
  const first = positionOf(starts, start)
  const [last, lastColumn] = positionOf(starts, end)
  const counts = new Map()
  const covering = segmentAt(segments, first)
  for (let line = first[0]; line <= last && line < segments.starts.length - 1; line++) {
    const from = line === first[0] && covering >= 0 ? covering : segments.starts[line]
    for (let k = from; k < segments.starts[line + 1]; k++) {
      if (line === last && segments.columns[k] >= lastColumn) break
      if (segments.sources[k] >= 0) counts.set(segments.sources[k], (counts.get(segments.sources[k]) ?? 0) + 1)
    }
  }
  let best = null
  for (const [file, count] of counts) if (best === null || count > counts.get(best)) best = file
  return best === null ? null : map.files[best]
}
