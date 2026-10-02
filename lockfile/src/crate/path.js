// Rust's std::path, as of Rust 1.97: Path::file_name, as Unix reads a path
// and as Windows does (sys/path/windows_prefix.rs). Windows takes `/` and
// `\` as separators, after a prefix: a drive, `C:`, a server's share,
// `\\server\share`, a device, `\\.\COM1`, or a verbatim one, `\\?\C:`,
// `\\?\UNC\server\share` or `\\?\name`, after which, but for a root, `\`
// alone separates and `.` is a component of its own.

const SEPARATOR = /[\\/]/u

// The next component and what follows its separator.
function component(rest, verbatim) {
  const at = verbatim ? rest.indexOf('\\') : rest.search(SEPARATOR)
  return at === -1 ? [rest, ''] : [rest.slice(0, at), rest.slice(at + 1)]
}

// parse_prefix: its length, and whether it is verbatim; undefined for none.
// Rust reads `/` as `\` in its first 8 bytes, which is as far as the
// prefixes it knows by their text reach.
function windowsPrefix(path) {
  const head = path.slice(0, 8).replaceAll('/', '\\')
  if (!head.startsWith('\\\\')) return /^[A-Za-z]:/u.test(path) ? { length: 2, verbatim: false } : undefined
  if (head.startsWith('?\\', 2) && !path.slice(0, 4).includes('/')) {
    if (head.startsWith('UNC\\', 4)) {
      const [server, rest] = component(path.slice(8), true)
      const [share] = component(rest, true)
      return { length: 8 + server.length + (share === '' ? 0 : 1 + share.length), verbatim: true }
    }
    if (/^[A-Za-z]:(?:[\\/]|$)/u.test(path.slice(4))) return { length: 6, verbatim: true }
    return { length: 4 + component(path.slice(4), true)[0].length, verbatim: true }
  }
  if (head.startsWith('.\\', 2)) return { length: 4 + component(path.slice(4), false)[0].length, verbatim: false }
  const [server, rest] = component(path.slice(2), false)
  const [share] = component(rest, false)
  return server !== '' && share !== '' ? { length: 3 + server.length + share.length, verbatim: false } : undefined
}

// The last component, where it is a name; undefined where the path ends in
// none: it is empty, or ends in `..`, a root or a prefix, or `.` after a
// verbatim prefix. A `.` elsewhere is no component.
export function fileName(path, windows) {
  const prefix = windows ? windowsPrefix(path) : undefined
  const verbatim = prefix?.verbatim === true
  // A root is a separator of either kind, verbatim or not.
  const body = path.slice(prefix?.length ?? 0).replace(windows ? /^[\\/]/u : /^\//u, '')
  const parts = body.split(verbatim ? '\\' : (windows ? SEPARATOR : '/'))
  const last = parts.findLast((part) => part !== '' && (verbatim || part !== '.'))
  return last === '..' || last === '.' ? undefined : last
}
