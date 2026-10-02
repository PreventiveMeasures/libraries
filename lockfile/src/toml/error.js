import { LineError } from '../excerpt.js'

export class TomlError extends LineError {}

// `detail` may be a function, so that only a refusal pays for its message.
export function assert(condition, src, detail) {
  if (!condition) throw new TomlError(typeof detail === 'function' ? detail() : detail, src.line)
}

export { EXCERPT, excerpt } from '../excerpt.js'
