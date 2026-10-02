// How git 2.43's convert.c has `git archive` write a file's line ends, on a
// server at its defaults, core.autocrlf false and core.eol native, LF:
// unchanged, but where the text, crlf and eol attributes ask CRLF of it,
// each LF alone then written CRLF.

const [BINARY, TEXT, TEXT_INPUT, TEXT_CRLF, AUTO, AUTO_INPUT, AUTO_CRLF, UNDEFINED] = Array.from({ length: 8 }, (_, i) => i)

// git_path_check_crlf, of `text` or the older `crlf`: set, unset, or one
// of two values; true is the attribute set, not `=true`.
function checkCrlf(value) {
  if (value === true) return TEXT
  if (value === false) return BINARY
  if (value === 'input') return TEXT_INPUT
  if (value === 'auto') return AUTO
  return UNDEFINED
}

// convert_attrs, of what attributesOf says of a path.
function crlfAction(attributes) {
  let action = checkCrlf(attributes.get('text'))
  if (action === UNDEFINED) action = checkCrlf(attributes.get('crlf'))
  if (action !== BINARY) {
    const eol = attributes.get('eol')
    if (action === AUTO && eol === 'lf') action = AUTO_INPUT
    else if (action === AUTO && eol === 'crlf') action = AUTO_CRLF
    else if (eol === 'lf') action = TEXT_INPUT
    else if (eol === 'crlf') action = TEXT_CRLF
  }
  if (action === TEXT) return TEXT_INPUT
  return action === UNDEFINED ? BINARY : action
}

// gather_stats: the line ends, and what convert_is_binary weighs.
function statsOf(bytes) {
  const stats = { crlf: 0, lonecr: 0, lonelf: 0, nul: 0, printable: 0, nonprintable: 0 }
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]
    if (byte === 0x0d) {
      if (bytes[i + 1] === 0x0a) {
        stats.crlf++
        i++
      } else {
        stats.lonecr++
      }
    } else if (byte === 0x0a) {
      stats.lonelf++
    } else if (byte === 0x7f || (byte < 0x20 && ![0x08, 0x09, 0x1b, 0x0c].includes(byte))) {
      stats.nonprintable++
      if (byte === 0) stats.nul++
    } else {
      stats.printable++
    }
  }
  if (bytes.at(-1) === 0x1a) stats.nonprintable--
  return stats
}

const isBinary = ({ lonecr, nul, printable, nonprintable }) => lonecr > 0 || nul > 0 || (printable >> 7) < nonprintable

// What crlf_to_worktree makes of a blob at a path of `attributes`: null
// where it never writes CRLF there, else a function of the blob, which it
// may leave be.
export function lineEndsRewriter(attributes) {
  const action = crlfAction(attributes)
  if (action !== TEXT_CRLF && action !== AUTO_CRLF) return null
  return (bytes) => {
    const stats = statsOf(bytes)
    if (stats.lonelf === 0 || (action === AUTO_CRLF && (stats.lonecr > 0 || stats.crlf > 0 || isBinary(stats)))) return bytes
    const out = new Uint8Array(bytes.length + stats.lonelf)
    let at = 0
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0x0a && bytes[i - 1] !== 0x0d) out[at++] = 0x0d
      out[at++] = bytes[i]
    }
    return out
  }
}
