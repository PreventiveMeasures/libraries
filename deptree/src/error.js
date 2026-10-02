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

// What a failure beneath is refused with: itself, where it is a refusal
// already, or else a refusal of its message that says `where`, with it as
// the cause.
export const refusalOf = (error, where) => (error instanceof DeptreeError ? error : new DeptreeError(error.message, where, { cause: error }))

// A piece of an input for a message: quoted, cut short where it runs long,
// and with every control, line separator and bidirectional control
// escaped, so a name cannot act on a terminal or reorder what is shown.
const UNSHOWN = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu
export function quote(text) {
  const cut = text.length > 200 ? `${text.slice(0, text.codePointAt(199) > 0xFFFF ? 199 : 200)}…` : text
  return JSON.stringify(cut).replaceAll(UNSHOWN, (char) => `\\u${char.codePointAt(0).toString(16).padStart(4, '0')}`)
}

// The first key two mappings of strings differ at, for a message: `sides`
// names where each is from, and `same` tells two values alike.
export function difference(a, b, [aSide, bSide], same = (x, y) => x === y) {
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const inA = Object.hasOwn(a, key)
    const inB = Object.hasOwn(b, key)
    if (inA && inB && same(a[key], b[key])) continue
    return `${quote(key)} is ${inA ? quote(a[key]) : 'nothing'} in ${aSide} and ${inB ? quote(b[key]) : 'nothing'} in ${bSide}`
  }
  return undefined
}
