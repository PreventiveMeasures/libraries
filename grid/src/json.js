// Reading the JSON a model was asked for out of what it actually sent. Every prompt in this package
// ends with "return only JSON", and most answers comply; the rest wrap it in a code fence, put a
// sentence before it, or both. None of that is an error worth a re-ask, so the parse finds the JSON
// and ignores the rest. What SHAPE the JSON has is the caller's to check -- a page's picks, a row's
// answers -- since that is where the question of what counts as valid lives.

const FENCE = /```(?:json)?\s*([\s\S]*?)```/u

// The outermost value of one kind: from its first opening bracket to its last closing one. Tried
// for an object first and an array second, so a sentence like "the picks [below]" ahead of an
// object does not win over the object.
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

// The shape checks the modules share. Each throws the message the retry nudge is built around, so
// a model that sent the wrong shape is told what was expected rather than asked again blind.
export function expectObject(value, what) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`expected a JSON object with ${what}`)
  return value
}

// A list of non-empty strings, each trimmed, with anything else in the list dropped rather than
// refused: one blank answer among eight is not worth a re-ask, and the caller pads what is missing.
export function stringList(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
}

// A score as the model sent it: a finite number, or a string holding one, which a model asked for a
// number sometimes quotes. Anything else is undefined rather than coerced -- Number(null) is 0 and
// Number(true) is 1, and either read as a score would demote a finalist for a malformed answer.
export function numberOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/u.test(value.trim())) return Number(value)
  return undefined
}

// One line, for a row rendered into a page: a summary the model wrote with a newline in it would
// otherwise read as two rows.
export const oneLine = (text) => String(text ?? '').replace(/\s*\n\s*/gu, ' ').trim()
