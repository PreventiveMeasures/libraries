// A project.pbxproj as Xcodeproj writes it: an ASCII property list, the objects by kind and id, with the
// comments Xcode has beside an id.

import { createHash } from 'node:crypto'

const QUOTED = /^$|[^\w.$/]|^___/u
const ESCAPES = { '\u0007': String.raw`\a`, '\b': String.raw`\b`, '\f': String.raw`\f`, '\n': String.raw`\n`, '\r': String.raw`\r`, '\t': String.raw`\t`, '\v': String.raw`\v`, '"': String.raw`\"`, '\\': '\\\\' }
const text = (value) => (QUOTED.test(value) ? `"${value.replaceAll(/[\p{Cc}"\\]/gu, (char) => ESCAPES[char] ?? `\\U${char.codePointAt(0).toString(16).padStart(4, '0')}`)}"` : value)

const PHASE_NAMES = { PBXHeadersBuildPhase: 'Headers', PBXSourcesBuildPhase: 'Sources', PBXFrameworksBuildPhase: 'Frameworks', PBXResourcesBuildPhase: 'Resources', PBXCopyFilesBuildPhase: 'CopyFiles', PBXShellScriptBuildPhase: 'ShellScript' }
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && typeof value.isa === 'string'
const nameOf = (object) => object.name ?? object.path?.split('/').at(-1) ?? PHASE_NAMES[object.isa]

// Every object the project holds, once each, by what holds it.
function collect(root) {
  const objects = new Map()
  const visit = (object, owner) => {
    if (objects.has(object)) return
    objects.set(object, owner)
    for (const [key, value] of Object.entries(object)) {
      if (key.startsWith('_') || key === 'remoteGlobalIDString') continue
      for (const item of Array.isArray(value) ? value : [value]) if (isObject(item)) visit(item, object)
    }
  }
  visit(root, undefined)
  return objects
}

function commentOf(object, owner, root) {
  switch (object.isa) {
    case 'PBXProject': return 'Project object'
    case 'PBXBuildFile': return `${nameOf(object.fileRef)} in ${nameOf(owner)}`
    case 'XCConfigurationList': return `Build configuration list for ${owner.isa} "${owner === root ? 'Pods' : owner.name}"`
    case 'PBXTargetDependency': case 'PBXContainerItemProxy': return object.isa
    default: return nameOf(object)
  }
}

// Ids that stay the same from one run to the next: by an object's kind and name, and those of what holds it.
function assignIds(objects) {
  const ids = new Map()
  const taken = new Set()
  const keyOf = (object) => {
    const chain = []
    for (let at = object; at !== undefined; at = objects.get(at)) chain.push(`${at.isa}:${nameOf(at) ?? ''}:${at.fileRef === undefined ? '' : `${nameOf(at.fileRef)}:${at.fileRef.path}`}`)
    return chain.join('/')
  }
  for (const object of objects.keys()) {
    const key = keyOf(object)
    let id
    for (let salt = 0; id === undefined || taken.has(id); salt++) id = createHash('md5').update(`${key}#${salt}`).digest('hex').toUpperCase()
    taken.add(id)
    ids.set(object, id)
  }
  return ids
}

export function writeProject(project) {
  const { root } = project
  const objects = collect(root)
  const ids = assignIds(objects)
  const reference = (object) => {
    const comment = commentOf(object, objects.get(object), root)
    return comment === undefined ? ids.get(object) : `${ids.get(object)} /* ${comment} */`
  }
  const value = (item, indent, flat) => {
    const [newline, deeper] = flat ? [' ', ''] : [`\n${indent}\t`, `${indent}\t`]
    if (isObject(item)) return reference(item)
    if (Array.isArray(item)) return `(${item.map((one) => `${newline}${value(one, deeper, flat)},`).join('')}${flat ? ' ' : `\n${indent}`})`
    if (typeof item === 'object') return `{${Object.keys(item).sort().map((key) => `${newline}${text(key)} = ${value(item[key], deeper, flat)};`).join('')}${flat ? ' ' : `\n${indent}`}}`
    return text(String(item))
  }
  const entry = (object) => {
    const flat = object.isa === 'PBXBuildFile' || object.isa === 'PBXFileReference'
    const keys = Object.keys(object).filter((key) => key !== 'isa' && !key.startsWith('_') && object[key] !== undefined).sort()
    const fields = keys.map((key) => [key, key === 'remoteGlobalIDString' ? ids.get(object[key]) : value(object[key], '\t\t\t', flat)])
    if (flat) return `\t\t${reference(object)} = {isa = ${object.isa}; ${fields.map(([key, one]) => `${text(key)} = ${one}; `).join('')}};\n`
    return `\t\t${reference(object)} = {\n\t\t\tisa = ${object.isa};\n${fields.map(([key, one]) => `\t\t\t${text(key)} = ${one};\n`).join('')}\t\t};\n`
  }
  const kinds = Map.groupBy(objects.keys(), (object) => object.isa)
  const sections = [...kinds.keys()].sort().map((isa) => {
    const entries = kinds.get(isa).sort((a, b) => (ids.get(a) < ids.get(b) ? -1 : 1)).map(entry).join('')
    return `\n/* Begin ${isa} section */\n${entries}/* End ${isa} section */\n`
  })
  return `// !$*UTF8*$!\n{\n\tarchiveVersion = 1;\n\tclasses = {\n\t};\n\tobjectVersion = ${project.objectVersion};\n\tobjects = {\n${sections.join('')}\t};\n\trootObject = ${reference(root)};\n}\n`
}
