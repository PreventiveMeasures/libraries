// `line` counts from zero; the message counts from one.
export class TomlError extends Error {
  constructor(detail, line) {
    super(line === undefined ? detail : `${detail} at line ${line + 1}`)
    this.name = 'TomlError'
    this.line = line
  }
}

// `detail` may be a function, so that only a refusal pays for its message.
export function assert(condition, src, detail) {
  if (!condition) throw new TomlError(typeof detail === 'function' ? detail() : detail, src.line)
}

export { EXCERPT, excerpt } from '../excerpt.js'
