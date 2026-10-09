import { segmentsOf } from './map.js'

// The parser's offsets and the map's columns both count UTF-16 code units.

// JavaScript's line breaks, by which an engine numbers a stack frame's line:
// the format leaves them to the generated code's language.
const BREAK = /\r\n?|[\n\u2028\u2029]/gu

export function lineStarts(code) {
  const starts = [0]
  for (const match of code.matchAll(BREAK)) starts.push(match.index + match[0].length)
  return starts
}

// The last index of sorted `array[lo..hi)` at or before `value`, or lo - 1.
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

export function positionOf(starts, offset) {
  const line = lastAtOrBefore(starts, 0, starts.length, offset)
  return [line, offset - starts[line]]
}

// As a debugger reads a frame: the last segment on the line at or before
// the column, or -1.
function segmentAt(segments, [line, column]) {
  if (line >= segments.starts.length - 1) return -1
  const from = segments.starts[line]
  const found = lastAtOrBefore(segments.columns, from, segments.starts[line + 1], column)
  return found < from ? -1 : found
}

export function fileAt(map, starts, offset) {
  const segments = segmentsOf(map)
  const found = segmentAt(segments, positionOf(starts, offset))
  return found < 0 || segments.sources[found] < 0 ? null : map.files[segments.sources[found]]
}

// The file most segments over [start, end) name, counting the one `start`
// falls under.
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
