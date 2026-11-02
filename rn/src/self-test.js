// rn-bundle --self-test: two builds' modules, each as Babel made it, compared.

// Where a module's Babel output differs between two builds, each by its
// `cache` (bundle()'s): ours, and one with none of the config's plugins left
// out for having nothing to do (load.js's keepPlugins). Each as esbuild
// prints it, so that its quotes, layout and comments are alike; a module's
// inline source map left out. -> [{ path, line, ours, kept }]: the first line
// of each that differs, by path; a module in one build alone, of no line.
export async function differences(esbuild, ours, kept) {
  const found = []
  for (const path of new Set([...ours.keys(), ...kept.keys()])) {
    const [a, b] = [ours, kept].map((cache) => cache.get(path)?.result?.contents)
    if (a === b) continue
    if (a === undefined || b === undefined) {
      found.push({ path, line: null, ours: a === undefined ? null : '', kept: b === undefined ? null : '' })
      continue
    }
    const [linesA, linesB] = (await Promise.all([a, b].map((contents) => printed(esbuild, contents)))).map((code) => code.split('\n'))
    const at = linesA.findIndex((line, index) => line !== linesB[index])
    if (at === -1 && linesA.length === linesB.length) continue
    const index = at === -1 ? linesA.length : at
    found.push({ path, line: index + 1, ours: linesA[index] ?? '', kept: linesB[index] ?? '' })
  }
  return found.toSorted((x, y) => (x.path < y.path ? -1 : 1))
}

const MAP = /\/\/# sourceMappingURL=data:[^\n]*\n?$/u

async function printed(esbuild, contents) {
  const code = typeof contents === 'string' ? contents : new TextDecoder().decode(contents)
  try {
    return (await esbuild.transform(code.replace(MAP, ''), { loader: 'js', logLevel: 'silent' })).code
  } catch {
    return code
  }
}
