// Whether `renamed` binds as `before` does by oxc's minifier: both mangled,
// every variable named by its place alone, they read the same. A check apart
// from analyze's, each catching what the other misses; the top level as `kind`.

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
