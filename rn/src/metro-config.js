// A metro.config.js, read off its ESTree AST, never run (its getDefaultConfig
// needs Metro).

import { literalString, readLists } from './config-lists.js'

const ASSET_LISTS = new Map([['assetExts', 'asset']])

// The extensions the config lists among `resolver.assetExts`, besides
// Metro's defaults it spreads in: `assetExts: [...defaults, 'riv']`,
// `config.resolver.assetExts.push('riv')`. One it filters out is still listed.
export function metroAssetExts(program) {
  const exts = new Set()
  readLists(program, ASSET_LISTS, (_, node) => {
    const ext = literalString(node)
    if (ext !== null) exts.add(ext)
  })
  return [...exts]
}

// The form read with no parser: `assetExts: [...defaults.assetExts, 'riv']`.
const SPREAD_AND_STRINGS = /assetExts\s*:\s*\[\s*\.\.\.[\w$.?]+\.assetExts((?:\s*,\s*(?:'[^'\\\n]*'|"[^"\\\n]*"))*)\s*,?\s*\]/gu

// With no parser: the extensions listed where the config names `assetExts`
// in that form alone (each match names it twice); none where it names it
// nowhere. Null where it names it otherwise, which needs metroAssetExts.
export function scanMetroAssetExts(source) {
  const mentions = source.split('assetExts').length - 1
  const matches = [...source.matchAll(SPREAD_AND_STRINGS)]
  if (mentions !== matches.length * 2) return null
  return [...new Set(matches.flatMap(([, strings]) => [...strings.matchAll(/'([^']*)'|"([^"]*)"/gu)].map(([, single, double]) => single ?? double)))]
}
