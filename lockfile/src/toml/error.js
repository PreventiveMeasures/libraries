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
// long: a line may be a megabyte, and a message is for a person to read.
export const excerpt = (text) => (text.length > 64 ? `${JSON.stringify(text.slice(0, 64))}...` : JSON.stringify(text))
