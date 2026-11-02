// rn-bundle --self-test: two builds' modules, each as Babel made it, compared.

import { aliasing } from './babel-aliases.js'

// Where a module's Babel output differs between two builds, each by its
// `cache` (bundle()'s): ours, and one with none of the config's plugins left
// out for having nothing to do (load.js's keepPlugins), and module-resolver
// in each, where ours maps its aliases as it resolves each import. Each as
// esbuild prints it, so that its quotes, layout and comments are alike; a
// module's inline source map left out; where ours maps aliases so, each
// import of each as esbuild finds it, ours mapped as the bundle maps it.
// -> [{ path, line, ours, kept }]: the first line of each that differs, by
// path; a module in one build alone, of no line.
export async function differences(esbuild, ours, kept) {
  const found = []
  for (const path of new Set([...ours.keys(), ...kept.keys()])) {
    const [a, b] = [ours, kept].map((cache) => cache.get(path)?.result?.contents)
    if (a === b) continue
    if (a === undefined || b === undefined) {
      found.push({ path, line: null, ours: a === undefined ? null : '', kept: b === undefined ? null : '' })
      continue
    }
    const mapped = ours.get(path).result.pluginData?.aliases
    const map = mapped === undefined ? null : aliasing(mapped)
    const print = (contents, of) => (map === null ? printed(esbuild, contents) : withImports(esbuild, contents, path, of))
    const [linesA, linesB] = (await Promise.all([print(a, map), print(b, null)])).map((code) => code.split('\n'))
    const at = linesA.findIndex((line, index) => line !== linesB[index])
    if (at === -1 && linesA.length === linesB.length) continue
    const index = at === -1 ? linesA.length : at
    found.push({ path, line: index + 1, ours: linesA[index] ?? '', kept: linesB[index] ?? '' })
  }
  return found.toSorted((x, y) => (x.path < y.path ? -1 : 1))
}

const MAP = /\/\/# sourceMappingURL=data:[^\n]*\n?$/u
// eslint-disable-next-line require-unicode-regexp -- esbuild's filters are Go regexps, which take no `u`
const ANY = /.*/

// As printed(), each import of the module, as esbuild finds it, mapped by
// `map` where given, as the bundle maps it.
async function withImports(esbuild, contents, path, map) {
  const code = (typeof contents === 'string' ? contents : new TextDecoder().decode(contents)).replace(MAP, '')
  const specifiers = { name: 'specifiers', setup: (build) => build.onResolve({ filter: ANY }, ({ path: specifier }) => ({ path: map?.(path, specifier) ?? specifier, external: true })) }
  try {
    const { outputFiles } = await esbuild.build({ stdin: { contents: code, loader: 'js' }, bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent', plugins: [specifiers] })
    return outputFiles[0].text
  } catch {
    return printed(esbuild, code)
  }
}

async function printed(esbuild, contents) {
  const code = typeof contents === 'string' ? contents : new TextDecoder().decode(contents)
  try {
    return (await esbuild.transform(code.replace(MAP, ''), { loader: 'js', logLevel: 'silent' })).code
  } catch {
    return code
  }
}
