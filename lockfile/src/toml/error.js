// `line` counts from zero; the message counts from one.
export class TomlError extends Error {
  constructor(detail, line) {
    super(line === undefined ? detail : `${detail} at line ${line + 1}`)
    this.name = 'TomlError'
    this.line = line
  }
}

// Every check the reader makes goes through here: a condition that does not
// hold is a refusal on the line the reader is at, never a guess at what the
// text meant. `detail` is the message, or a function that makes it where
// making it costs something, so that only a refusal pays for it.
export function assert(condition, src, detail) {
  if (!condition) throw new TomlError(typeof detail === 'function' ? detail() : detail, src.line)
}

// A piece of the input for a message, quoted, and cut short where it runs
// long, between characters: a line may be a megabyte, and a message is for
// a person to read. Every control, line separator and bidirectional control
// is escaped, where JSON leaves DEL, C1, U+2028, U+2029 and the bidi
// controls as they are, so that a file cannot act on the terminal a message
// is shown in, nor reorder what it shows.
const UNSHOWN = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu

export function excerpt(text) {
  const cut = text.length > 64 ? text.slice(0, text.codePointAt(63) > 0xFFFF ? 63 : 64) : text
  const quoted = JSON.stringify(cut).replaceAll(UNSHOWN, (char) => `\\u${char.codePointAt(0).toString(16).padStart(4, '0')}`)
  return cut === text ? quoted : `${quoted}...`
}
