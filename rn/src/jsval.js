// A JSON value as generated JavaScript code has it: @exodus/schemasafe's jsval() (src/safe-format.js; MIT,
// Copyright (c) 2014 Mathias Buus, Copyright (c) 2020 Exodus Movement), of JSON values alone, which is all rn
// writes, as an ES module (replaceAll, codePointAt, `u` flags: lint's).

const escapeCode = (code) => `\\u${code.toString(16).padStart(4, '0')}`

// JSON.stringify(), with minor fixes to negate the JS/JSON parsing differences.
export const jsval = (val) =>
  JSON.stringify(val)
    // JSON context and JS eval context have different handling of __proto__ property name
    // Refs: https://www.ecma-international.org/ecma-262/#sec-json.parse
    // Refs: https://www.ecma-international.org/ecma-262/#sec-__proto__-property-names-in-object-initializers
    // Replacement is safe because it's the only way that encodes __proto__ property in JSON and
    // it can't occur inside strings or other properties, due to the leading `"` and traling `":`
    .replaceAll(/([,{])"__proto__":/gu, '$1["__proto__"]:')
    // The above line should cover all `"__proto__":` occurances except for `"...\"__proto__":`
    .replaceAll(/[^\\]"__proto__":/gu, () => {
      throw new Error('Unreachable')
    })
    // https://v8.dev/features/subsume-json#security, e.g. {'\u2028':0} on Node.js 8
    .replaceAll(/[\u2028\u2029]/gu, (char) => escapeCode(char.codePointAt(0)))
