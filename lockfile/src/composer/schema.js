// Composer 2.10's schema of composer.json, as Factory holds the file to
// before it loads it, of what is read or hashed here but the name and the
// links, which root.js holds to it: the version, minimum-stability,
// prefer-stable, extra, config.platform, and each repository, of the
// fields of its type. A package repository's package is held to its name
// and version alone, as the schema holds the rest of it to URLs and emails
// as PHP's filter_var takes them.

import { LockfileError, at, quote } from '../error.js'
import { refuse } from '../shape.js'

const TYPES = {
  string: [(value) => typeof value === 'string', 'a string'],
  boolean: [(value) => typeof value === 'boolean', 'true or false'],
  object: [(value) => value instanceof Map, 'a mapping'],
  array: [Array.isArray, 'a sequence'],
  null: [(value) => value === null, 'null'],
}

// A value as a part of the schema holds it to, in the schema's words: of a
// type, or of one of several, of an enum or a pattern, and the properties,
// required and additionalProperties of an object, or the items of an
// array.
function check(value, schema, where) {
  const types = [schema.type].flat()
  if (!types.some((type) => TYPES[type][0](value))) throw refuse(types.map((type) => TYPES[type][1]).join(' or '), value, where)
  if (schema.enum !== undefined && !schema.enum.includes(value)) throw refuse(`one of ${schema.enum.map(quote).join(', ')}`, value, where)
  if (schema.pattern !== undefined && !schema.pattern.test(value)) throw new LockfileError(`${quote(value)} is not as Composer's schema has it`, where)
  if (value instanceof Map) {
    for (const key of schema.required ?? []) {
      if (!value.has(key)) throw new LockfileError(`no ${quote(key)}, which Composer's schema requires`, where)
    }
    for (const [key, item] of value) {
      const of = schema.properties !== undefined && Object.hasOwn(schema.properties, key) ? schema.properties[key] : schema.additionalProperties
      if (of !== undefined) check(item, of, at(where, key))
    }
  }
  if (Array.isArray(value) && schema.items !== undefined) value.forEach((item, index) => check(item, schema.items, `${where}[${index}]`))
}

const STRING = { type: 'string' }
const BOOLEAN = { type: 'boolean' }
const STRINGS = { type: 'array', items: STRING }
const PATH = { type: ['string', 'boolean'] }
const INLINE = { type: 'object', required: ['name', 'version'], properties: { name: STRING, version: STRING } }

// Of each type of repository, what the schema has of it beside its type
// and these.
const EVERY = { name: STRING, canonical: BOOLEAN, only: STRINGS, exclude: STRINGS }
const VCS = { url: STRING, 'no-api': BOOLEAN, 'secure-http': BOOLEAN, 'svn-cache-credentials': BOOLEAN, 'trunk-path': PATH, 'branches-path': PATH, 'tags-path': PATH, 'package-path': STRING, depot: STRING, branch: STRING, unique_perforce_client_name: STRING, p4user: STRING, p4password: STRING }
const REPOSITORIES = {
  composer: { url: STRING, options: { type: 'object' }, allow_ssl_downgrade: BOOLEAN, 'force-lazy-providers': BOOLEAN, filter: { type: ['boolean', 'object'], additionalProperties: BOOLEAN } },
  ...Object.fromEntries(['vcs', 'github', 'git', 'gitlab', 'bitbucket', 'git-bitbucket', 'hg', 'fossil', 'perforce', 'svn', 'forgejo'].map((type) => [type, VCS])),
  path: { url: STRING, options: { type: 'object', properties: { reference: { type: 'string', enum: ['none', 'config', 'auto'] }, symlink: { type: ['boolean', 'null'] }, relative: BOOLEAN, versions: { type: 'object', additionalProperties: STRING } } } },
  artifact: { url: STRING },
  pear: { url: STRING, 'vendor-alias': STRING },
  package: { package: { ...INLINE, type: ['object', 'array'], items: INLINE } },
}

// One of the types above, named or not; of a map, `anonymous`, the key
// names it.
function checkRepository(value, where, anonymous) {
  check(value, { type: 'object' }, where)
  const type = value.get('type')
  if (typeof type !== 'string' || !Object.hasOwn(REPOSITORIES, type)) throw refuse('a type of repository Composer knows', type, at(where, 'type'))
  check(value, { type: 'object', required: [type === 'package' ? 'package' : 'url'], properties: { ...EVERY, ...REPOSITORIES[type] } }, where)
  if (anonymous && value.has('name')) throw new LockfileError('a name, where the key names a repository, which Composer\'s schema refuses', at(where, 'name'))
}

// A list of repositories, each of which may instead disable one by its
// name, `{"packagist.org": false}`; or a map of them by name, a repository
// or false.
function checkRepositories(value, where) {
  check(value, { type: ['object', 'array'] }, where)
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (!(item instanceof Map && item.size === 1 && [...item.values()][0] === false)) checkRepository(item, `${where}[${index}]`, false)
    })
  } else {
    for (const [key, item] of value) {
      if (item !== false) checkRepository(item, at(where, key), true)
    }
  }
}

// The schema's pattern of a version, which the root's is held to before it
// is normalized: one not of a branch has nothing after it but a stability
// and build metadata. Of a line end, which PCRE's `.` and `$` take
// otherwise, readVersion refuses the version anyway.
const VERSION = /^[vV]?\d+(?:[.-]\d+){0,3}[._-]?(?:(?:[sS][tT][aA][bB][lL][eE]|[bB][eE][tT][aA]|[bB]|[rR][cC]|[aA][lL][pP][hH][aA]|[aA]|[pP][aA][tT][cC][hH]|[pP][lL]|[pP])(?:[.-]?\d+)*)?(?:[.-]?[dD][eE][vV]|\.x-dev)?(?:\+.*)?$|^dev-.*$/su

const FIELDS = {
  version: { type: 'string', pattern: VERSION },
  'minimum-stability': { type: 'string', enum: ['dev', 'alpha', 'beta', 'rc', 'RC', 'stable'] },
  'prefer-stable': BOOLEAN,
  extra: { type: ['object', 'array'] },
  config: { type: 'object', properties: { platform: { type: 'object', additionalProperties: PATH } } },
}

export function checkSchema(config, where) {
  for (const [key, schema] of Object.entries(FIELDS)) {
    if (config.has(key)) check(config.get(key), schema, at(where, key))
  }
  if (config.has('repositories')) checkRepositories(config.get('repositories'), at(where, 'repositories'))
}
