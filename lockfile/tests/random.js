// A linear congruential generator, enough to spread the pieces of a
// document about, its product taken in 32 bits: as a double it runs past
// 2^53 and is rounded, and the sequence falls into a cycle some ten thousand
// long. The seed is fixed, so a failure comes back on a rerun.
export function random(seed) {
  let state = seed
  const next = () => (state = (Math.imul(state, 1103515245) + 12345) & 0x7FFF_FFFF) / 2 ** 31
  return { next, pick: (list) => list[Math.floor(next() * list.length)] }
}
