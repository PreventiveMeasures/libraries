// A project's asset extensions, read without running its Metro config, for tools that must not run
// it (stasis). rn-bundle and rn-serve load the config instead (metro-options.js).

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

import { defaults } from './defaults.js'
import { metroAssetExts, scanMetroAssetExts } from './metro-config.js'
import { added, metroConfigOf, readRnConfig } from './rn-config.js'

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

// Metro's asset extensions plus rn.config.json's assetExts if set, else plus those the Metro config adds,
// parsed with oxc-parser where available, else a regex.
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
