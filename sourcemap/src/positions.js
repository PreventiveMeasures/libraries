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

// [line, column] of `offset`, both from zero.
export function positionOf(starts, offset) {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return [lo, offset - starts[lo]]
}

// The segment a position falls under: the last on its line that starts at
// or before it, as a debugger reads a frame.
function segmentAt(lines, line, column) {
  const segments = lines[line]
  if (!segments || segments.length === 0 || segments[0][0] > column) return undefined
  let lo = 0
  let hi = segments.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (segments[mid][0] <= column) lo = mid
    else hi = mid - 1
  }
  return segments[lo]
}

// The file the code at `offset` came from, or null where the map says
// nothing or says it came from nowhere.
export function fileAt(map, starts, offset) {
  const [line, column] = positionOf(starts, offset)
  const segment = segmentAt(segmentsOf(map), line, column)
  return segment && segment.length > 1 ? map.files[segment[1]] : null
}

// The file most of the segments in [start, end) came from, or null where
// none of them came from a file.
export function fileWithin(map, starts, start, end) {
  const lines = segmentsOf(map)
  const [first, firstColumn] = positionOf(starts, start)
  const [last, lastColumn] = positionOf(starts, end)
  const counts = new Map()
  for (let line = first; line <= last && line < lines.length; line++) {
    for (const segment of lines[line]) {
      if (segment.length === 1) continue
      if ((line === first && segment[0] < firstColumn) || (line === last && segment[0] >= lastColumn)) continue
      counts.set(segment[1], (counts.get(segment[1]) ?? 0) + 1)
    }
  }
  let best = null
  for (const [file, count] of counts) if (best === null || count > counts.get(best)) best = file
  return best === null ? null : map.files[best]
}
