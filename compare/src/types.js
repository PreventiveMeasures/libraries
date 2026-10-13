// types.node.js where Node does not run this: with no type stripping of Node's to hold oxc's tree to,
// no text is proven to hold types alone, and neither oxc nor anything else is loaded for it.

export function proveTypeOnly(text) {
  if (typeof text !== 'string') throw new TypeError(`a text must be a string, not ${typeof text}`)
  if (!text.isWellFormed()) throw new TypeError('a text must be a well-formed string')
  return { proven: false, reason: 'unsupported', at: null }
}
