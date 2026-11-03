// JSON as generated JavaScript code has it, as @exodus/schemasafe's jsval() writes it (src/safe-format.js):
// a key __proto__ an object's own, not its prototype as in an object literal; and U+2028 and U+2029, which
// end a string literal before ES2019, escaped.
export const jsval = (value) =>
  JSON.stringify(value)
    .replaceAll(/([,{])"__proto__":/gu, '$1["__proto__"]:')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
