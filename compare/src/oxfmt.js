// oxfmt, an optional peer of pretty.js, loaded on first use; one missing is
// thrown as the environment's error, not taken for a file that won't format.
let format

export async function loadFormatter() {
  try {
    format ??= (await import('oxfmt')).format
  } catch (cause) {
    throw new Error("@preventive/compare/pretty.js needs the optional 'oxfmt' peer dependency; install it (e.g. `npm i oxfmt`)", { cause })
  }
  return format
}
