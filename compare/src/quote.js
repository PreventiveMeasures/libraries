// Paths as git's quote_c_style writes them under core.quotePath: C-quoted when
// holding a control, `"`, `\` or anything past ASCII, each UTF-8 byte of such
// a character escaped by its C letter or in octal. A space stays bare.

import { utf8fromString } from '@exodus/bytes/utf8.js'

const LETTERS = new Map([[0x07, 'a'], [0x08, 'b'], [0x09, 't'], [0x0A, 'n'], [0x0B, 'v'], [0x0C, 'f'], [0x0D, 'r'], [0x22, '"'], [0x5C, '\\']])
const UNSAFE = /[^ !#-[\]-~]/gu

const escapeByte = (byte) => `\\${LETTERS.get(byte) ?? byte.toString(8).padStart(3, '0')}`

// `prefix`, git's `a/` or `b/`, goes inside the quotes: "a/x\ty".
export function quote(name, prefix = '') {
  const escaped = name.replace(UNSAFE, (char) => Array.from(utf8fromString(char), escapeByte).join(''))
  return escaped === name ? prefix + name : `"${prefix}${escaped}"`
}
