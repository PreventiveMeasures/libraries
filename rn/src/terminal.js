// Text a client gave (an app's console, a device's name, a request's URL),
// as the terminal rn-serve writes to shows it, which would take a control
// character in it as its own: to move the cursor and write over a line,
// clear the screen, retitle the window, write the clipboard (OSC 52), link
// text elsewhere (OSC 8), or have the terminal answer a report into its
// input. Its lines and tabs kept, a CRLF a line's end; with `colors`, its
// colors (SGR, ESC [ ... m), as console.log prints them, then reset, for
// none to color the lines after; each other control character (C0, DEL,
// C1) shown as an escape, \x1B, of no effect.

const CONTROL = /\r\n|\p{Cc}(?:\[[\d;:]*m)?/gu
const ESC = 0x1b
const RESET = '\u001B[0m'

const escaped = (char) => (char === '\n' || char === '\t' ? char : `\\x${char.codePointAt(0).toString(16).toUpperCase().padStart(2, '0')}`)

export function printable(text, { colors = true } = {}) {
  // Whether a color it set is on at its end: of none but a reset after it.
  let colored = false
  const shown = text.replace(CONTROL, (match) => {
    if (match === '\r\n') return '\n'
    if (match.length > 1 && match.codePointAt(0) === ESC && colors) {
      colored = !/^0*$/u.test(match.slice(2, -1))
      return match
    }
    // A control, and what follows it, which looked like a color's rest.
    return escaped(match[0]) + match.slice(1)
  })
  return colored ? `${shown}${RESET}` : shown
}
