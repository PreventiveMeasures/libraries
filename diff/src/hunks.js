// From a change set to what the context formats print: hunks, each a run of
// changes close enough to share context lines. Two changes belong to one
// hunk when the unchanged lines between them number at most twice the
// context — exactly when their context lines would touch or overlap.

export function groupHunks(blocks, context, aLength, bLength) {
  const hunks = []
  let i = 0
  while (i < blocks.length) {
    let j = i
    while (j + 1 < blocks.length && blocks[j + 1].a0 - blocks[j].a1 <= 2 * context) j++
    const first = blocks[i], last = blocks[j]
    hunks.push({
      blocks: blocks.slice(i, j + 1),
      a0: Math.max(0, first.a0 - context), a1: Math.min(aLength, last.a1 + context),
      b0: Math.max(0, first.b0 - context), b1: Math.min(bLength, last.b1 + context),
    })
    i = j + 1
  }
  return hunks
}

// -p: the last line before the hunk that looks like the start of a
// function, which by default means one beginning `[[:alpha:]$_]`, cut to 40
// bytes with trailing blanks dropped.
const FUNCTION_START = /^[A-Za-z$_]/u

// The cut is by bytes, so a caller that carries its own UTF-8 pair — one
// that refuses what it could not hand back out, say — passes it in; without
// one, these stand in.
const utf8 = new TextEncoder()
const strict = new TextDecoder('utf-8', { fatal: true })

// A 40-byte cut can land inside a character; drop the partial one rather
// than let a replacement character stand in for it. `encode` is UTF-8, so
// only a truncation can fail, and never more than three bytes' worth.
function decodeUtf8(bytes) {
  for (let end = bytes.length; ; end--) {
    try { return strict.decode(bytes.subarray(0, end)) } catch { /* cut one byte shorter */ }
  }
}

export function functionLine(lines, before, encode = (text) => utf8.encode(text), decode = decodeUtf8) {
  for (let i = before - 1; i >= 0; i--) {
    if (!FUNCTION_START.test(lines[i])) continue
    const bytes = encode(lines[i].replace(/\n$/u, ''))
    let end = Math.min(40, bytes.length)
    while (end > 0 && isSpaceByte(bytes[end - 1])) end--
    return decode(bytes.subarray(0, end))
  }
  return null
}

const isSpaceByte = (byte) => byte === 32 || (byte >= 9 && byte <= 13)
