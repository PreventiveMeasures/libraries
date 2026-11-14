// The blanks of the C locale, the newline among them
const BLANKS = /[ \t\n\v\f\r]+/gu
// The lookbehind starts a match only where a run starts, so a run short of the end is not retried
const TRAILING = /(?<![ \t\n\v\f\r])[ \t\n\v\f\r]+$/u

// Case folding in the C locale reaches ASCII and stops
const fold = (text) => text.replace(/[A-Z]/gu, (c) => c.toLowerCase())

// What two lines are compared by under -i and -w / -b / -Z, or null to compare records as they are.
// A record keeps its terminator, which the whitespace options take as whitespace.
export function lineComparisonKey({ ignoreCase = false, whitespace = 'none' } = {}) {
  let key = null
  if (whitespace === 'all') key = (line) => line.replace(BLANKS, '')
  else if (whitespace === 'change') key = (line) => line.replace(TRAILING, '').replace(BLANKS, ' ')
  else if (whitespace === 'trailing') key = (line) => line.replace(TRAILING, '')
  if (!ignoreCase) return key
  return key ? (line) => fold(key(line)) : fold
}

// Records with their terminators; the last may lack one
export const splitRecords = (text) => text.match(/[^\n]*\n|[^\n]+/gu) ?? []
