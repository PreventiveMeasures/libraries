// How diff decides two lines are the same. Each line reduces to a key under
// the options in force, and two lines are the same line when their keys are
// equal — which is the whole of what the comparison options mean. Records
// keep their terminator: a last line without one is a different line from a
// complete one, except under the whitespace options, where the newline is
// whitespace like any other.

// The blanks of the C locale, the newline among them.
const SPACE = /[ \t\n\v\f\r]/gu
const SPACE_RUN = /[ \t\n\v\f\r]+/gu
const TRAILING_SPACE = /[ \t\n\v\f\r]+$/u

// Case folding in the C locale reaches ASCII and stops.
const fold = (text) => text.replace(/[A-Z]/gu, (c) => c.toLowerCase())

// null means identity: compare records as they are.
export function lineKey({ ignoreCase = false, whitespace = 'none' } = {}) {
  let key = null
  if (whitespace === 'all') key = (line) => line.replace(SPACE, '')
  // A run of blanks reads as one space, unless it runs to the end of the line.
  else if (whitespace === 'change') key = (line) => line.replace(TRAILING_SPACE, '').replace(SPACE_RUN, ' ')
  else if (whitespace === 'trailing') key = (line) => line.replace(TRAILING_SPACE, '')
  if (!ignoreCase) return key
  return key ? (line) => fold(key(line)) : fold
}

// Records with their terminators; the last may lack one.
export function splitRecords(text) {
  const records = []
  for (let pos = 0; pos < text.length;) {
    const end = text.indexOf('\n', pos)
    const next = end < 0 ? text.length : end + 1
    records.push(text.slice(pos, next))
    pos = next
  }
  return records
}

// --strip-trailing-cr edits the text before it is split, so the output
// shows the stripped lines too rather than the ones that were read.
export const stripTrailingCr = (text) => text.replace(/\r\n/gu, '\n')

// A NUL byte marks the input binary. diff decides that from the first block
// it reads; text handed over as a string arrives whole, so the whole of it
// is what is looked at.
export const isBinary = (text) => text.includes('\0')
