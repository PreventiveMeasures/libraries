// diff's headers name files in the style of a C string literal: a name with
// nothing awkward in it is printed bare; one with a space, a quote, a
// backslash or a control character is double-quoted with C escapes, and in
// a byte locale every byte past ASCII is an octal escape too.
//
// Which locale is in force is the caller's to know: `byteLocale` says there
// are no characters past ASCII, only bytes, and is what LC_ALL, LC_CTYPE or
// LANG naming C or POSIX comes to.
const NAMED = new Map([['', 'a'], ['\b', 'b'], ['\f', 'f'], ['\n', 'n'], ['\r', 'r'], ['\t', 't'], ['\v', 'v'], ['"', '"'], ['\\', '\\']])

// Unpaired surrogates have no UTF-8 of their own; TextEncoder writes the
// replacement character for one, which is what gets escaped.
const utf8 = new TextEncoder()

export function quoteHeaderName(name, { byteLocale = false } = {}) {
  let out = ''
  let needed = false
  for (const char of name) {
    const code = char.codePointAt(0)
    const named = NAMED.get(char)
    if (named !== undefined) { out += '\\' + named; needed = true }
    else if (char === ' ') { out += char; needed = true }
    else if (code < 32 || code === 127 || (code > 127 && (byteLocale || /[\p{C}\p{Zl}\p{Zp}]/u.test(char)))) {
      for (const byte of utf8.encode(char)) out += '\\' + byte.toString(8).padStart(3, '0')
      needed = true
    } else out += char
  }
  return needed ? `"${out}"` : name
}
