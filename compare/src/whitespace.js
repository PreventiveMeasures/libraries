// Whether diff -w, as `blocks` were found with it, hides a change in blanks of
// more than one kind: a line kept as unchanged whose blanks between the same
// two characters differ and mix kinds, as spaces turned to tabs.

// The blanks diff -w leaves out of a line: the C locale's.
const BLANK = /[ \t\n\v\f\r]/u

const lines = (text) => {
  const list = text.split('\n')
  if (list.at(-1) === '') list.pop()
  return list
}

// Two lines alike but for their blanks: whether, before any of their other
// characters or after the last, their blanks differ and hold two kinds.
function mixesBlanks(x, y) {
  for (let i = 0, j = 0; ; i++, j++) {
    let gapX = '', gapY = ''
    while (i < x.length && BLANK.test(x[i])) gapX += x[i++]
    while (j < y.length && BLANK.test(y[j])) gapY += y[j++]
    if (gapX !== gapY && new Set(gapX + gapY).size > 1) return true
    if (i >= x.length || j >= y.length) return false
  }
}

export function hidesMixedWhitespace(before, after, blocks) {
  const a = lines(before), b = lines(after)
  let ai = 0, bi = 0
  for (let run = 0; run <= blocks.length; run++) {
    const end = run < blocks.length ? blocks[run].a0 : a.length
    for (; ai < end; ai++, bi++) if (a[ai] !== b[bi] && mixesBlanks(a[ai], b[bi])) return true
    if (run < blocks.length) ({ a1: ai, b1: bi } = blocks[run])
  }
  return false
}
