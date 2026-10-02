// Ruby compares strings by their bytes, which for UTF-8 is the order of
// their code points; JS compares UTF-16 code units, which is not, past
// U+FFFF.
export function compareCodePoints(a, b) {
  const [x, y] = [Array.from(a), Array.from(b)]
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i].codePointAt(0) - y[i].codePointAt(0)
  }
  return x.length - y.length
}
