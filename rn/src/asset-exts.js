// A project's asset extensions, read off its files, never running its Metro
// config, for what must not run it (stasis): rn-bundle and rn-serve load it,
// as Metro does (metro-options.js). Of its rn.config.json, as they take it:
// its assetExts, which a Metro config can't set too, and else its
// metroConfig. The reading of a config's source is metro-config.js's, pure.

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

import { defaults } from './defaults.js'
import { metroAssetExts, scanMetroAssetExts } from './metro-config.js'
import { metroConfigOf, readRnConfig } from './rn-config.js'

const tryResolve = (from, name) => {
  try {
    return from.resolve(name)
  } catch {
    return null
  }
}

// oxc-parser, the project's, else the one beside rn/; null where neither is.
function locateOxc(projectRoot) {
  const path = tryResolve(createRequire(resolve(projectRoot, 'package.json')), 'oxc-parser') ?? tryResolve(createRequire(import.meta.url), 'oxc-parser')
  return path === null ? null : createRequire(import.meta.url)(path)
}

// Metro's asset extensions, and those the project's metro.config.js (`file`,
// from the project, where given; else rn.config.json's metroConfig, of none
// where false) adds, read off it, never run: by its AST with oxc-parser
// (`oxc`, its module; the project's, else the one beside rn/, where not
// given; none where null), else in the one form a regex reads; then those
// rn.config.json's assetExts adds. Metro's defaults alone where there's no
// metro.config.js; throws where `file` isn't there, or only a parser reads
// it and there's none, or rn.config.json is not one rn-bundle takes. Where
// rn.config.json has assetExts, Metro's defaults and them, reading no
// Metro config: rn-bundle and rn-serve refuse one that sets them otherwise.
export function readMetroAssetExts(projectRoot, { file = null, oxc } = {}) {
  const rnConfig = readRnConfig(projectRoot, (message) => {
    throw new Error(message)
  })
  const metro = rnConfig.assetExts === undefined ? readOff(projectRoot, metroConfigOf(file ?? undefined, rnConfig), oxc) : [...defaults.assetExts]
  return [...metro, ...(rnConfig.assetExts ?? []).filter((ext, i, added) => !metro.includes(ext) && added.indexOf(ext) === i)]
}

function readOff(projectRoot, file, oxc) {
  if (file === false) return [...defaults.assetExts]
  const config = resolve(projectRoot, file ?? 'metro.config.js')
  if (!existsSync(config)) {
    if (file === null) return [...defaults.assetExts]
    throw new Error(`no such Metro config: ${file}`)
  }
  const source = readFileSync(config, 'utf8')
  const parser = oxc === undefined ? locateOxc(projectRoot) : oxc
  const listed = parser === null ? scanMetroAssetExts(source) : metroAssetExts(parser.parseSync(config, source, { sourceType: 'unambiguous' }).program)
  if (listed === null) throw new Error(`reading the assetExts of ${file ?? 'metro.config.js'} needs oxc-parser: npm i -D oxc-parser`)
  return [...defaults.assetExts, ...listed]
}
