// pretty.js's optional peers, loaded on first use. oxfmt it can't do without:
// one missing is thrown as the environment's error, not taken for a file that
// won't format. css-tree checks CSS: null where missing, so CSS is refused.
let csstree, format

export async function loadFormatter() {
  try {
    format ??= (await import('oxfmt')).format
  } catch (cause) {
    throw new Error("@preventive/compare/pretty.js needs the optional 'oxfmt' peer dependency; install it (e.g. `npm i oxfmt`)", { cause })
  }
  return format
}

export async function loadCssTree() {
  csstree ??= await import('css-tree').catch(() => null)
  return csstree
}
