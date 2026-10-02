// `where` is what is refused, such as `pnpm-workspace.yaml: nodeLinker`, or
// undefined for the call as a whole; the message leads with it.
export class DeptreeError extends Error {
  constructor(detail, where, options) {
    super(where === undefined ? detail : `${where}: ${detail}`, options)
    this.name = 'DeptreeError'
    this.where = where
  }
}

export const refusalOf = (error, where) => (error instanceof DeptreeError ? error : new DeptreeError(error.message, where, { cause: error }))

// Controls, line separators and bidirectional controls are escaped, so that
// a name cannot act on a terminal or reorder what is shown.
const UNSHOWN = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu
export function quote(text) {
  const cut = text.length > 200 ? `${text.slice(0, text.codePointAt(199) > 0xFFFF ? 199 : 200)}…` : text
  return JSON.stringify(cut).replaceAll(UNSHOWN, (char) => `\\u${char.codePointAt(0).toString(16).padStart(4, '0')}`)
}

// The first key two mappings of strings differ at, for a message; `sides`
// names where each is from.
export function difference(a, b, [aSide, bSide], same = (x, y) => x === y) {
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const inA = Object.hasOwn(a, key)
    const inB = Object.hasOwn(b, key)
    if (inA && inB && same(a[key], b[key])) continue
    return `${quote(key)} is ${inA ? quote(a[key]) : 'nothing'} in ${aSide} and ${inB ? quote(b[key]) : 'nothing'} in ${bSide}`
  }
  return undefined
}
