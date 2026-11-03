// A project's asset extensions, read from its files without running its Metro config, for tools
// that must not run it (stasis). rn-bundle and rn-serve load the config instead (metro-options.js).

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

import { defaults } from './defaults.js'
import { metroAssetExts, scanMetroAssetExts } from './metro-config.js'
import { added, metroConfigOf, readRnConfig } from './rn-config.js'

const tryResolve = (from, name) => {
  try {
    return from.resolve(name)
  } catch {
    return null
  }
}

// oxc-parser, the project's, else the one beside rn/; null if neither.
function locateOxc(projectRoot) {
  const fromHere = createRequire(import.meta.url)
  const path = tryResolve(createRequire(resolve(projectRoot, 'package.json')), 'oxc-parser') ?? tryResolve(fromHere, 'oxc-parser')
  return path === null ? null : fromHere(path)
}

// Metro's asset extensions plus those the Metro config adds (`file`, else rn.config.json's
// metroConfig), parsed with `oxc` (oxc-parser's module, found if not given; null for none) or a
// regex, then rn.config.json's assetExts; if it has those, no Metro config is read.
export function readMetroAssetExts(projectRoot, { file = null, oxc } = {}) {
  const rnConfig = readRnConfig(projectRoot, (message) => {
    throw new Error(message)
  })
  const metro = rnConfig.assetExts === undefined ? readOff(projectRoot, metroConfigOf(file, rnConfig), oxc) : defaults.assetExts
  return added(metro, rnConfig.assetExts ?? [])
}

function readOff(projectRoot, file, oxc) {
  if (file === false) return defaults.assetExts
  const config = resolve(projectRoot, file ?? 'metro.config.js')
  if (!existsSync(config)) {
    if (file === null) return defaults.assetExts
    throw new Error(`no such Metro config: ${file}`)
  }
  const source = readFileSync(config, 'utf8')
  const parser = oxc === undefined ? locateOxc(projectRoot) : oxc
  const listed = parser === null ? scanMetroAssetExts(source) : metroAssetExts(parser.parseSync(config, source, { sourceType: 'unambiguous' }).program)
  if (listed === null) throw new Error(`reading the assetExts of ${file ?? 'metro.config.js'} needs oxc-parser: npm i -D oxc-parser`)
  return [...defaults.assetExts, ...listed]
}
