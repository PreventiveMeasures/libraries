// `line` counts from zero; the message counts from one.
export class YamlError extends Error {
  constructor(detail, line) {
    super(line === undefined ? detail : `${detail} at line ${line + 1}`)
    this.name = 'YamlError'
    this.line = line
  }
}

// A piece of the input for a message, quoted, and cut short where it runs
// long: a line may be a megabyte, and a message is for a person to read.
// The cut falls between characters, and the controls, line separators and
// bidi controls JSON leaves raw are escaped, so input cannot act on a
// terminal or reorder what is shown.
const UNSHOWN = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu
export function excerpt(text) {
  const cut = text.length > 64 ? text.slice(0, text.codePointAt(63) > 0xFFFF ? 63 : 64) : text
  const quoted = JSON.stringify(cut).replaceAll(UNSHOWN, (char) => `\\u${char.codePointAt(0).toString(16).padStart(4, '0')}`)
  return cut === text ? quoted : `${quoted}...`
}
