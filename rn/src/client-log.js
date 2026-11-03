// Prints the app's console, which HMRClient sends, as Metro's terminal does (logToConsole; MIT,
// Copyright (c) Meta Platforms, Inc. and affiliates): a level label, the mode unless BRIDGE, group
// indentation, nothing inside collapsed groups, and control characters escaped (terminal.js).

import { format } from 'node:util'

import { printable } from './terminal.js'

// Warn and reset if a collapsed group isn't ended within this many ms.
const COLLAPSED_GUARD = 3000

// `style(format, text)` is util.styleText's, for the stream `write` goes to.
export function createClientLog(write, style = (_, text) => text) {
  const groups = []
  let guard = null
  const collapsed = () => groups.includes('groupCollapsed')
  return (level, mode, data) => {
    if (typeof level !== 'string' || !Array.isArray(data)) return
    if (level === 'groupEnd') {
      groups.pop()
      if (groups.length === 0) clearTimeout(guard)
      return
    }
    if (level === 'group' || level === 'groupCollapsed') groups.push(level)
    if (level === 'groupCollapsed') {
      clearTimeout(guard)
      guard = setTimeout(() => {
        if (!collapsed()) return
        write(`${style(['inverse', 'yellow', 'bold'], ' WARN ')} Expected \`console.groupEnd\` to be called after \`console.groupCollapsed\`.`)
        groups.length = 0
      }, COLLAPSED_GUARD).unref()
      return
    }
    if (collapsed()) return
    // As Metro: the level's name if console has that method, but trace's is LOG.
    const named = Object.hasOwn(console, level) && typeof console[level] === 'function' && level !== 'trace' ? level : 'log'
    const color = level === 'error' ? 'red' : level === 'warn' ? 'yellow' : 'white'
    const tag = typeof mode !== 'string' || mode === '' || mode === 'BRIDGE' ? '' : `(${printable(mode.toUpperCase(), { colors: false })}) `
    const items = data.map((item, i) => (i === data.length - 1 && typeof item === 'string' ? item.trimEnd() : item))
    write(`${style(['inverse', color, 'bold'], ` ${tag}${named.toUpperCase()} `)}${' '.repeat(groups.length * 2)} ${printable(format(...items))}`)
  }
}
