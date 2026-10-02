// What Psych, the YAML parser of Ruby that CocoaPods reads a Podfile.lock
// with, makes of a plain scalar: Psych::ScalarScanner#tokenize, as of Psych
// 5, with the looser integers of Psych 3 too, which Ruby before 3.1 has,
// where `9,` is 9; and a date or a time Psych reads as a string only for
// being none, as `2026-13-45`, is taken for one. YAMLHelper quotes some of
// the strings Psych would type, by a list of its own, and writes others
// plain: `1,000`, `1_0`, `1:30`, `nUll`, and before CocoaPods 1.10 `yes`
// and `off`, are each a string to CocoaPods as it writes them and another
// thing as it reads them back.

const WORDY = /^[^\d.:-]?[\p{Alpha}_ \t\n\v\f\r!@#$%^&*(){}<>|/\\~;=]/u
const TIME = /^-?\d{4}-\d{1,2}-\d{1,2}(?:[Tt]|[ \t\n\v\f\r]+)\d{1,2}:\d\d:\d\d(?:\.\d*)?(?:[ \t\n\v\f\r]*(?:Z|[-+]\d{1,2}:?(?:\d\d)?))?$/u
const DATE = /^\d{4}-(?:1[012]|0\d|\d)-(?:[12]\d|3[01]|0\d|\d)$/u
const SEXAGESIMAL = /^[-+]?\d[\d_]*(?::[0-5]?\d){1,2}(?:\.[\d_]*)?$/u
const FLOAT = /^[-+]?(?:\d[\d_,]*)?\.\d*(?:[eE][-+]\d+)?$/u
const INTEGERS = [
  /^[-+]?0b[01_,]+$/u,
  /^[-+]?0[0-7_,]+$/u,
  /^[-+]?(?:0|[1-9][\d_,]*)$/u,
  /^[-+]?0x[\dA-Fa-f_,]+$/u,
]

// `string`, `boolean`, or what else Psych reads `text` as, for a message.
function typeOf(text) {
  if (text === '') return 'null'
  if (WORDY.test(text) || text.includes('\n')) {
    if (text.length > 5 || /^[^ytonf~]/iu.test(text)) return 'string'
    if (text === '~' || /^null$/iu.test(text)) return 'null'
    return /^(?:yes|true|on|no|false|off)$/iu.test(text) ? 'boolean' : 'string'
  }
  if (TIME.test(text)) return 'a time'
  if (DATE.test(text)) return 'a date'
  if (/^[-+]?\.inf$/iu.test(text) || /^\.nan$/iu.test(text)) return 'a float'
  if (/^:./u.test(text)) return 'a symbol'
  if (SEXAGESIMAL.test(text)) return 'a number'
  if (FLOAT.test(text) && !/^[-+]?\.$/u.test(text)) return 'a float'
  if (INTEGERS.some((re) => re.test(text))) return 'an integer'
  return 'string'
}

// What Psych reads `text` as: its type, as above, and of a string or a
// boolean, its value.
export function psychRead(text) {
  const type = typeOf(text)
  return { type, value: type === 'boolean' ? /^(?:yes|true|on)$/iu.test(text) : text }
}
