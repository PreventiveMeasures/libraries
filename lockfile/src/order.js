// Ruby and Rust compare strings by their bytes, which for UTF-8 is the
// order of their code points; JS compares UTF-16 code units, which is not,
// past U+FFFF. Of well-formed strings, which the readers alone take: a
// pair splits at the code unit where two strings first differ, and so the
// code points there are the first that differ.
export function compareCodePoints(a, b) {
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i++) if (a[i] !== b[i]) return a.codePointAt(i) - b.codePointAt(i)
  return a.length - b.length
}
