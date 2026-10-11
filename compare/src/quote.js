// Names as git writes them in a patch (quote_c_style in quote.c): bare, or in
// C quotes where they hold a character git will not write bare -- a control,
// a double quote, a backslash, or anything past ASCII, which git quotes by
// default (core.quotePath) -- each byte of it escaped, by its letter where C
// has one and in three octal digits otherwise. A space is written bare.

const encoder = new TextEncoder()
const LETTERS = new Map([[0x07, 'a'], [0x08, 'b'], [0x09, 't'], [0x0A, 'n'], [0x0B, 'v'], [0x0C, 'f'], [0x0D, 'r'], [0x22, '"'], [0x5C, '\\']])

const mustQuote = (code) => code < 0x20 || code === 0x22 || code === 0x5C || code >= 0x7F
const needsQuote = (name) => [...name].some((char) => mustQuote(char.codePointAt(0)))

function escaped(name) {
  let out = ''
  for (const char of name) {
    if (!mustQuote(char.codePointAt(0))) {
      out += char
      continue
    }
    for (const byte of encoder.encode(char)) out += `\\${LETTERS.get(byte) ?? byte.toString(8).padStart(3, '0')}`
  }
  return out
}

export const quote = (name) => (needsQuote(name) ? `"${escaped(name)}"` : name)

// A name behind its `a/` or `b/`, the two quoted as one: "a/x\ty".
export const quotePrefixed = (prefix, name) => (needsQuote(name) ? `"${prefix}${escaped(name)}"` : prefix + name)
