// JSON for generated code, as @exodus/schemasafe's jsval() writes it (src/safe-format.js): a __proto__ key stays
// own (an object literal would set the prototype), and U+2028/U+2029 (string ends before ES2019) are escaped.
export const jsval = (value) =>
  JSON.stringify(value)
    .replaceAll(/([,{])"__proto__":/gu, '$1["__proto__"]:')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
