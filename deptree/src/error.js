// `where` is what a refusal is about — a file and the setting or key in
// it, `pnpm-workspace.yaml: nodeLinker`, or a package and the file in it —
// or undefined for the call as a whole; the message leads with it. What a
// package below refused with is kept as the `cause`.
export class DeptreeError extends Error {
  constructor(detail, where, options) {
    super(where === undefined ? detail : `${where}: ${detail}`, options)
    this.name = 'DeptreeError'
    this.where = where
  }
}

// A piece of an input for a message: quoted, cut short where it runs long,
// and with every control, line separator and bidirectional control
// escaped, so a name cannot act on a terminal or reorder what is shown.
const UNSHOWN = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu
export function quote(text) {
  const cut = text.length > 200 ? `${text.slice(0, text.codePointAt(199) > 0xFFFF ? 199 : 200)}…` : text
  return JSON.stringify(cut).replaceAll(UNSHOWN, (char) => `\\u${char.codePointAt(0).toString(16).padStart(4, '0')}`)
}

// The first key two mappings of strings differ at, for a message: `sides`
// names where each is from.
export function difference(a, b, [aSide, bSide]) {
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = Object.hasOwn(a, key) ? quote(a[key]) : 'nothing'
    const y = Object.hasOwn(b, key) ? quote(b[key]) : 'nothing'
    if (x !== y) return `${quote(key)} is ${x} in ${aSide} and ${y} in ${bSide}`
  }
  return undefined
}
