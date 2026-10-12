// css-tree, an optional peer of pretty.js that CSS is checked with, loaded on
// first use; null where it is missing, so that CSS is refused, never unchecked.
let csstree

export async function loadCssTree() {
  csstree ??= await import('css-tree').catch(() => null)
  return csstree
}
