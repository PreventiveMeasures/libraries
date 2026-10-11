// Whether `renamed` binds as `before` does, by oxc's minifier: each mangled,
// every variable named by its place alone and never by its name, they read
// the same. A variable that would read another, a global one, a property or an
// export renamed, any of them makes the two differ. The top level as the old
// text's analysis has it: a module's or a CommonJS module's mangled with the
// rest, a script's, whose names are globals, left as it is.
//
// Each check holds where the other may not, and both must pass: oxc reads a
// function declared in a block as the block's alone even outside strict code
// (analyze refuses one: `block-function`), does not tell a `var` named as a
// `let` of a block it is written in (misread does), and reads a name beside a
// `catch`'s `var` of its parameter's name otherwise than JavaScript does.

import { getOxc } from '#oxc'

export function bindsAlike(before, renamed, { module = false, commonjs = false, own = module || commonjs } = {}) {
  const { minifySync } = getOxc()
  const file = module ? 'file.mjs' : commonjs ? 'file.cjs' : 'file.js'
  const mangled = (text) => {
    try {
      const result = minifySync(file, text, { module, compress: false, mangle: { toplevel: own }, codegen: { removeWhitespace: true } })
      return result.errors.length === 0 ? result.code : null
    } catch {
      return null
    }
  }
  const code = mangled(before)
  return code !== null && code === mangled(renamed)
}
