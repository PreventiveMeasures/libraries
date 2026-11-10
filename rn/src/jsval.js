// JSON to embed in generated code, as @exodus/schemasafe's jsval(): a `__proto__` key stays an own key, and
// U+2028/U+2029 (which end strings before ES2019) are escaped.
export const jsval = (value) =>
  JSON.stringify(value)
    .replaceAll(/([,{])"__proto__":/gu, '$1["__proto__"]:')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
