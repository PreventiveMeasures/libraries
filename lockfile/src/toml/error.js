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

// Cut between characters, and with the controls, line separators and bidi
// controls JSON leaves raw escaped, so input cannot act on a terminal.
const UNSHOWN = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu
export const EXCERPT = 64

export function excerpt(text) {
  const cut = text.length > EXCERPT ? text.slice(0, text.codePointAt(EXCERPT - 1) > 0xFFFF ? EXCERPT - 1 : EXCERPT) : text
  const quoted = JSON.stringify(cut).replaceAll(UNSHOWN, (char) => `\\u${char.codePointAt(0).toString(16).padStart(4, '0')}`)
  return cut === text ? quoted : `${quoted}...`
}
