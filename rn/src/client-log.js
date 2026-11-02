// The app's console, which HMRClient sends the dev server, as Metro's
// terminal prints it (logToConsole; MIT, Copyright (c) Meta Platforms, Inc.
// and affiliates): each line labelled by its level (` LOG `, ` WARN `, ...),
// inverse, an error's red, a warning's yellow, the rest's white; of its
// mode where not the bridge's (`(NOBRIDGE) `); indented by the groups it is
// in, none of a collapsed one's printed; its data as console.log formats it.

import { format } from 'node:util'

// A collapsed group not ended this long after, it is taken for ended, warned of.
const COLLAPSED_GUARD = 3000

// `write(line)` each line; `style(format, text)`, util.styleText's, for the
// label, of the stream it goes to. -> (level, mode, data) => void.
export function createClientLog(write, style = (_, text) => text) {
  const groups = []
  let guard = null
  return (level, mode, data) => {
    if (typeof level !== 'string' || !Array.isArray(data)) return
    if (level === 'group' || level === 'groupCollapsed') groups.push(level)
    if (level === 'groupCollapsed') {
      clearTimeout(guard)
      guard = setTimeout(() => {
        if (!groups.includes('groupCollapsed')) return
        write(`${style(['inverse', 'yellow', 'bold'], ' WARN ')} Expected \`console.groupEnd\` to be called after \`console.groupCollapsed\`.`)
        groups.length = 0
      }, COLLAPSED_GUARD)
      guard.unref?.()
      return
    }
    if (level === 'groupEnd') {
      groups.pop()
      if (groups.length === 0) clearTimeout(guard)
      return
    }
    if (groups.includes('groupCollapsed')) return
    // As Metro has it, of a level its own console has, but trace's.
    const named = Object.hasOwn(console, level) && typeof console[level] === 'function' && level !== 'trace' ? level : 'log'
    const color = level === 'error' ? 'red' : level === 'warn' ? 'yellow' : 'white'
    const tag = typeof mode !== 'string' || mode === '' || mode === 'BRIDGE' ? '' : `(${mode.toUpperCase()}) `
    const items = data.map((item, i) => (i === data.length - 1 && typeof item === 'string' ? item.trimEnd() : item))
    write(`${style(['inverse', color, 'bold'], ` ${tag}${named.toUpperCase()} `)}${' '.repeat(groups.length * 2)} ${format(...items)}`)
  }
}
