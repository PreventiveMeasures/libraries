// types.node.js where Node does not run this: with no type stripping of Node's to hold oxc's tree to,
// no text is proven to hold types alone, and neither oxc nor anything else is loaded for it.

export function proveTypeOnly(text) {
  if (text instanceof Uint8Array) return { proven: false, reason: 'unsupported', at: null }
  if (typeof text !== 'string') throw new TypeError(`a text must be a string or its UTF-8 bytes, not ${typeof text}`)
  if (!text.isWellFormed()) throw new TypeError('a text must be a well-formed string')
  return { proven: false, reason: 'unsupported', at: null }
}
