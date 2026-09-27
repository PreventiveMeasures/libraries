// `where` is the place in the lockfile a refusal is about, as a property
// path from its top — `packages["q@1.5.1"].resolution` — or undefined for
// the file as a whole; the message leads with it.
export class LockfileError extends Error {
  constructor(detail, where) {
    super(where === undefined ? detail : `${where}: ${detail}`)
    this.name = 'LockfileError'
    this.where = where
  }
}

// A piece of the lockfile for a message: quoted, cut short where it runs
// long, and with every control, line separator and bidirectional control
// escaped, so a key cannot act on a terminal or reorder what is shown.
const UNSHOWN = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu
export function quote(text) {
  const cut = text.length > 200 ? `${text.slice(0, text.codePointAt(199) > 0xFFFF ? 199 : 200)}…` : text
  return JSON.stringify(cut).replaceAll(UNSHOWN, (char) => `\\u${char.codePointAt(0).toString(16).padStart(4, '0')}`)
}

// One step down a property path: `.key` where the key reads as one, `['k']`
// where it does not.
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u
export function at(where, key) {
  const step = IDENTIFIER.test(key) ? key : `[${quote(key)}]`
  return where === '' || step.startsWith('[') ? `${where}${step}` : `${where}.${step}`
}
