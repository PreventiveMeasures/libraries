// Text a client gave (console output, a device name, a URL), made safe to print, and the app's console
// as Metro's terminal prints it (logToConsole; MIT, Copyright (c) Meta Platforms, Inc. and affiliates).

import { format } from 'node:util'

// CRLF, else a control character and any SGR (color) parameters after it.
const CONTROL = /\r\n|\p{Cc}(?:\[([\d;:]*)m)?/gu
const RESET = '\u001B[0m'
// Warn and reset if a collapsed group isn't ended within this many ms.
const COLLAPSED_GUARD = 3000

const escaped = (char) => (char === '\n' || char === '\t' ? char : `\\x${char.codePointAt(0).toString(16).toUpperCase().padStart(2, '0')}`)

// Control characters, which could move the cursor, retitle the window or write the clipboard, are shown
// escaped (\x1B) but newline and tab; CRLF becomes LF; with `colors`, SGR colors are kept, then reset.
export function printable(text, { colors = true } = {}) {
  // Whether the last color set is still on at the end.
  let colored = false
  const shown = text.replace(CONTROL, (match, sgr) => {
    if (match === '\r\n') return '\n'
    if (colors && sgr !== undefined && match[0] === '\u001B') {
      colored = !/^0*$/u.test(sgr)
      return match
    }
    // Any `[...m` after the control is left as plain text.
    return escaped(match[0]) + match.slice(1)
  })
  return colored ? `${shown}${RESET}` : shown
}

// Prints the app's console, which HMRClient sends, with `write`: a level label, the mode unless BRIDGE,
// group indentation, nothing inside collapsed groups. `style(format, text)` is util.styleText's, for
// the stream `write` goes to.
export function createClientLog(write, style = (_, text) => text) {
  // Of each open group, whether it's collapsed.
  const groups = []
  let guard
  const label = (color, text) => style(['inverse', color, 'bold'], ` ${text} `)
  return (level, mode, data) => {
    if (typeof level !== 'string' || !Array.isArray(data)) return
    if (level === 'groupEnd') {
      groups.pop()
      if (groups.length === 0) clearTimeout(guard)
      return
    }
    if (level === 'groupCollapsed') {
      groups.push(true)
      clearTimeout(guard)
      guard = setTimeout(() => {
        if (!groups.includes(true)) return
        write(`${label('yellow', 'WARN')} Expected \`console.groupEnd\` to be called after \`console.groupCollapsed\`.`)
        groups.length = 0
      }, COLLAPSED_GUARD).unref()
      return
    }
    if (level === 'group') groups.push(false)
    if (groups.includes(true)) return
    // As Metro: the level's name if console has that method, but trace's is LOG.
    const named = Object.hasOwn(console, level) && typeof console[level] === 'function' && level !== 'trace' ? level : 'log'
    const color = level === 'error' ? 'red' : level === 'warn' ? 'yellow' : 'white'
    const tag = typeof mode !== 'string' || mode === '' || mode === 'BRIDGE' ? '' : `(${printable(mode.toUpperCase(), { colors: false })}) `
    const last = data.at(-1)
    const items = typeof last === 'string' ? data.with(data.length - 1, last.trimEnd()) : data
    write(`${label(color, `${tag}${named.toUpperCase()}`)}${' '.repeat(groups.length * 2)} ${printable(format(...items))}`)
  }
}
