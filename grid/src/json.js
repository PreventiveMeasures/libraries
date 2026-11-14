// The JSON a model was asked for, out of what it sent: a fence or a sentence around it is no error worth
// a re-ask. Its shape is the caller's to check, where what counts as valid is known.

const FENCE = /```(?:json)?\s*([\s\S]*?)```/u

// From the first opening bracket to the last closing one; an object is tried before an array, so
// "the picks [below]" ahead of an object does not win over it
function outermost(text, open, close) {
  const start = text.indexOf(open)
  if (start < 0) return null
  const end = text.lastIndexOf(close)
  if (end < start) return null
  try {
    return { value: JSON.parse(text.slice(start, end + 1)) }
  } catch {
    return null
  }
}

export function extractJSON(text) {
  if (typeof text !== 'string') throw new TypeError('extractJSON: expected the response text')
  const fenced = FENCE.exec(text)
  const candidates = fenced ? [fenced[1], text] : [text]
  for (const candidate of candidates) {
    const found = outermost(candidate, '{', '}') ?? outermost(candidate, '[', ']')
    if (found) return found.value
  }
  throw new SyntaxError('no JSON in the response')
}

// Each shape check throws what was expected, which the re-ask then carries
export function expectObject(value, what) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`expected a JSON object with ${what}`)
  return value
}

// A string trimmed, and anything else as '', so `true` or an object never reads as text
export const textOf = (value) => (typeof value === 'string' ? value.trim() : '')

// The non-empty strings of a list, trimmed; one blank answer among eight is not worth a re-ask
export function stringList(value) {
  if (!Array.isArray(value)) return []
  return value.map(textOf).filter(Boolean)
}

// The same, where every member has to be a sentence: a question dropped would read as fewer asked for
export function sentenceList(value, what) {
  if (!Array.isArray(value)) throw new TypeError(`expected a list of ${what}`)
  const kept = stringList(value)
  if (kept.length !== value.length) throw new TypeError(`expected every one of the ${what} to be a sentence`)
  return kept
}

// A finite number, or a string holding one, else undefined: Number(null) is 0 and Number(true) 1, and
// either read as a score would demote a finalist for a malformed answer
export function numberOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/u.test(value.trim())) return Number(value)
  return undefined
}

// A whole number from 1 to `size` by numberOf's rules, so `true` or `[1]` is never the first row
export function ordinalOf(value, size) {
  const n = numberOf(value)
  return n !== undefined && Number.isInteger(n) && n >= 1 && n <= size ? n : undefined
}

// The members of `list` whose `ordinal` is one on a page of `size`, each ordinal's first alone, as [n, member]
export function distinctOrdinals(list, size, ordinal = (member) => member) {
  const seen = new Set()
  return list.flatMap((member) => {
    const n = ordinalOf(ordinal(member), size)
    if (n === undefined || seen.has(n)) return []
    seen.add(n)
    return [[n, member]]
  })
}

// One line, so a summary with a newline in it does not read as two rows on a page
export const oneLine = (text) => String(text ?? '').replace(/\s*\n\s*/gu, ' ').trim()
