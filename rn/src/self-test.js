// rn-bundle --self-test: compares each module's Babel output between two builds.

import { aliasing } from './babel-aliases.js'

// Compares two builds' caches (bundle()'s `cache`): ours, and one keeping every config plugin and
// module-resolver (load.js's keepPlugins), both reprinted by esbuild without inline source maps.
// -> the first differing line of each module, sorted by path: [{ path, line, ours, kept }]
export async function differences(esbuild, ours, kept) {
  const found = []
  for (const path of [...new Set([...ours.keys(), ...kept.keys()])].toSorted()) {
    const [a, b] = [ours, kept].map((cache) => cache.get(path)?.result?.contents)
    if (a === b) continue
    // A module in one build only has no line.
    if (a === undefined || b === undefined) {
      found.push({ path, line: null, ours: a === undefined ? null : '', kept: b === undefined ? null : '' })
      continue
    }
    // Where ours left module-resolver's aliases to the bundle, map its imports as the bundle does.
    const mapped = ours.get(path).result.pluginData?.aliases
    const map = mapped === undefined ? null : aliasing(mapped)
    const print = (contents, of) => (map === null ? printed(esbuild, textOf(contents)) : withImports(esbuild, textOf(contents), path, of))
    const [linesA, linesB] = (await Promise.all([print(a, map), print(b, null)])).map((code) => code.split('\n'))
    const at = linesA.findIndex((line, index) => line !== linesB[index])
    if (at === -1 && linesA.length === linesB.length) continue
    const index = at === -1 ? linesA.length : at
    found.push({ path, line: index + 1, ours: linesA[index] ?? '', kept: linesB[index] ?? '' })
  }
  return found
}

const utf8 = new TextDecoder('utf-8', { fatal: true })
const textOf = (contents) => (typeof contents === 'string' ? contents : utf8.decode(contents))
const MAP = /\/\/# sourceMappingURL=data:[^\n]*\n?$/u
// eslint-disable-next-line require-unicode-regexp -- esbuild's filters are Go regexps, which take no `u`
const ANY = /.*/

// As printed(), with each import esbuild finds mapped by `map`, as the bundle maps it.
async function withImports(esbuild, contents, path, map) {
  const code = contents.replace(MAP, '')
  const specifiers = { name: 'specifiers', setup: (build) => build.onResolve({ filter: ANY }, ({ path: specifier }) => ({ path: map?.(path, specifier) ?? specifier, external: true })) }
  try {
    const { outputFiles } = await esbuild.build({ stdin: { contents: code, loader: 'js' }, bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent', plugins: [specifiers] })
    return outputFiles[0].text
  } catch {
    return printed(esbuild, code)
  }
}

async function printed(esbuild, code) {
  try {
    return (await esbuild.transform(code.replace(MAP, ''), { loader: 'js', logLevel: 'silent' })).code
  } catch {
    return code
  }
}
