// rn-bundle --self-test: compares each module's Babel output between two builds.

import { aliasing } from './babel-aliases.js'

// Compares two builds' caches: ours, and one with keepPlugins (every config plugin run), each module
// reprinted by esbuild. -> [{ path, line, ours, kept }]: each differing module's first differing line.
export async function differences(esbuild, ours, kept) {
  const found = []
  for (const path of [...new Set([...ours.keys(), ...kept.keys()])].toSorted()) {
    const [a, b] = [ours, kept].map((cache) => cache.get(path)?.result?.contents)
    if (a === b) continue
    if (a === undefined || b === undefined) {
      found.push({ path, line: null, ours: a === undefined ? null : '', kept: b === undefined ? null : '' })
      continue
    }
    // Where ours left module-resolver's aliases to the bundle, its imports are mapped through them first.
    const mapped = ours.get(path).result.pluginData?.aliases
    const map = mapped === undefined ? null : aliasing(mapped)
    const [printedA, printedB] = await Promise.all([
      printed(esbuild, a, map === null ? null : (specifier) => map(path, specifier) ?? specifier),
      printed(esbuild, b, map === null ? null : (specifier) => specifier),
    ])
    if (printedA === printedB) continue
    const [linesA, linesB] = [printedA, printedB].map((code) => code.split('\n'))
    let index = 0
    while (linesA[index] === linesB[index]) index++
    found.push({ path, line: index + 1, ours: linesA[index] ?? '', kept: linesB[index] ?? '' })
  }
  return found
}

const UTF8 = new TextDecoder('utf-8', { fatal: true })
const MAP = /\/\/# sourceMappingURL=data:[^\n]*\n?$/u
// eslint-disable-next-line require-unicode-regexp -- esbuild's filters are Go regexps, which take no `u`
const ANY = /.*/

// The module as esbuild prints it, without its inline source map and with imports through `mapped` if
// given; as it is where esbuild fails on it.
async function printed(esbuild, contents, mapped = null) {
  const text = typeof contents === 'string' ? contents : UTF8.decode(contents)
  const code = text.replace(MAP, '')
  try {
    if (mapped === null) return (await esbuild.transform(code, { loader: 'js', logLevel: 'silent' })).code
    const specifiers = { name: 'specifiers', setup: (build) => build.onResolve({ filter: ANY }, ({ path }) => ({ path: mapped(path), external: true })) }
    const { outputFiles } = await esbuild.build({ stdin: { contents: code, loader: 'js' }, bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent', plugins: [specifiers] })
    return outputFiles[0].text
  } catch {
    return mapped === null ? text : printed(esbuild, code)
  }
}
