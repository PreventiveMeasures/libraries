// A project's asset extensions, read from its files without running its Metro config, for tools
// that must not run it (stasis). rn-bundle and rn-serve load the config instead (metro-options.js).

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

import { defaults } from './defaults.js'
import { metroAssetExts, scanMetroAssetExts } from './metro-config.js'
import { added, metroConfigOf, readRnConfig } from './rn-config.js'

// oxc-parser, the project's, else the one beside rn/; null if neither.
function locateOxc(projectRoot) {
  const fromHere = createRequire(import.meta.url)
  let path
  try {
    path = fromHere.resolve('oxc-parser', { paths: [projectRoot, import.meta.dirname] })
  } catch {
    return null
  }
  return fromHere(path)
}

// Metro's asset extensions plus those the Metro config adds (`file`, else rn.config.json's
// metroConfig), parsed with `oxc` (oxc-parser's module, found if not given; null for none) or a
// regex, then rn.config.json's assetExts; if it has those, no Metro config is read.
export function readMetroAssetExts(projectRoot, { file = null, oxc } = {}) {
  const rnConfig = readRnConfig(projectRoot, (message) => {
    throw new Error(message)
  })
  if (rnConfig.assetExts !== undefined) return added(defaults.assetExts, rnConfig.assetExts)
  const given = metroConfigOf(file, rnConfig)
  if (given === false) return [...defaults.assetExts]
  const config = resolve(projectRoot, given ?? 'metro.config.js')
  if (!existsSync(config)) {
    if (given === null) return [...defaults.assetExts]
    throw new Error(`no such Metro config: ${given}`)
  }
  const source = readFileSync(config, 'utf8')
  const parser = oxc === undefined ? locateOxc(projectRoot) : oxc
  const listed = parser === null ? scanMetroAssetExts(source) : metroAssetExts(parser.parseSync(config, source, { sourceType: 'unambiguous' }).program)
  if (listed === null) throw new Error(`reading the assetExts of ${given ?? 'metro.config.js'} needs oxc-parser: npm i -D oxc-parser`)
  return [...defaults.assetExts, ...listed]
}
