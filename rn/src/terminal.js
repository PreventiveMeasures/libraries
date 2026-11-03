// Makes text a client gave (console output, a device name, a URL) safe to print: control characters,
// which could move the cursor, retitle the window or write the clipboard, are shown escaped (\x1B).
// Newlines and tabs are kept and CRLF becomes LF; with `colors`, SGR colors are kept, then reset.

const CONTROL = /\r\n|\p{Cc}(?:\[[\d;:]*m)?/gu
const RESET = '\u001B[0m'

const escaped = (char) => (char === '\n' || char === '\t' ? char : `\\x${char.codePointAt(0).toString(16).toUpperCase().padStart(2, '0')}`)

export function printable(text, { colors = true } = {}) {
  // Whether the last color set is still on at the end.
  let colored = false
  const shown = text.replace(CONTROL, (match) => {
    if (match === '\r\n') return '\n'
    if (colors && match.length > 1 && match[0] === '\u001B') {
      colored = !/^0*$/u.test(match.slice(2, -1))
      return match
    }
    // Escape the control; any `[...m` after it is left as plain text.
    return escaped(match[0]) + match.slice(1)
  })
  return colored ? `${shown}${RESET}` : shown
}
