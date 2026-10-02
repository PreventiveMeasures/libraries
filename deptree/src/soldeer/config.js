// The config `soldeer install` reads, as Soldeer 0.12 finds it:
// foundry.toml where it has a [dependencies] table, else soldeer.toml where
// there is no foundry.toml; where neither holds, Soldeer asks which to make
// its config, which is refused. Refused too: what Soldeer fails on as it
// adds `dependencies` to the default profile's libs, [soldeer] settings it
// fails on, and recursive_deps.

import { TomlError, isInlineTable, parseToml } from '@preventive/lockfile/toml.js'
import { DeptreeError } from '../error.js'

const isTable = (value) => typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === null
// A table toml_edit gives as one, from a header or a dotted key; one
// written inline it gives as a value, which Soldeer reads no dependencies
// from, and fails on for a profile.
const isTableItem = (value) => isTable(value) && !isInlineTable(value)

function parse(text, file) {
  try {
    return parseToml(text)
  } catch (error) {
    if (error instanceof TomlError) throw new DeptreeError(`not TOML read here: ${error.message}`, file, { cause: error })
    throw error
  }
}

// update_config_libs, which expects each of these to be what it adds where
// it is not there, and panics on another.
function checkLibs(doc) {
  const { profile } = doc
  if (profile === undefined) return
  if (!isTableItem(profile)) throw new DeptreeError('not a table, which Soldeer fails on', 'foundry.toml: profile')
  const defaults = profile.default
  if (defaults === undefined) return
  if (!isTableItem(defaults)) throw new DeptreeError('not a table, which Soldeer fails on', 'foundry.toml: profile.default')
  const { libs } = defaults
  if (libs !== undefined && (!Array.isArray(libs) || isTableItem(libs[0]))) throw new DeptreeError('not an array, which Soldeer fails on', 'foundry.toml: profile.default.libs')
}

const BOOLEANS = ['remappings_generate', 'remappings_regenerate', 'remappings_version', 'recursive_deps']

// read_soldeer_config's SoldeerConfig, by serde: each field of its type,
// any other passed over.
function checkSettings(settings, file) {
  if (settings === undefined) return
  const where = `${file}: soldeer`
  if (!isTable(settings)) throw new DeptreeError('not a table, which Soldeer fails on', where)
  for (const key of BOOLEANS) {
    if (settings[key] !== undefined && typeof settings[key] !== 'boolean') throw new DeptreeError('not true or false, which Soldeer fails on', `${where}.${key}`)
  }
  if (settings.remappings_prefix !== undefined && typeof settings.remappings_prefix !== 'string') throw new DeptreeError('not a string, which Soldeer fails on', `${where}.remappings_prefix`)
  if (![undefined, 'txt', 'config'].includes(settings.remappings_location)) throw new DeptreeError('not "txt" or "config", which Soldeer fails on', `${where}.remappings_location`)
  if (settings.recursive_deps === true) throw new DeptreeError('has Soldeer install what each dependency depends on too, which is not supported', `${where}.recursive_deps`)
}

const ASKS = 'Soldeer asks which file to make its config, which is not supported'

export function configOf({ foundry, soldeer }) {
  if (foundry === undefined && soldeer === undefined) throw new DeptreeError(`neither foundry.toml nor soldeer.toml is there, so ${ASKS}`)
  const file = foundry === undefined ? 'soldeer.toml' : 'foundry.toml'
  const config = parse(foundry ?? soldeer, file)
  if (foundry === undefined) {
    if (config.dependencies !== undefined && !isTableItem(config.dependencies)) throw new DeptreeError('not a table, which Soldeer reads no dependencies from, is not supported', 'soldeer.toml: dependencies')
  } else {
    if (!isTableItem(config.dependencies)) throw new DeptreeError(`no [dependencies] table, so ${ASKS}`, file)
    checkLibs(config)
  }
  checkSettings(config.soldeer, file)
  return config
}
