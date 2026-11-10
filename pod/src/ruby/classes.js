// Classes and modules: their methods, constants and ancestors, and how a method is found for a receiver.

import { RubyUnsupported, idOf } from './values.js'

export function newClass(it, name, superclass, { module = false, under = null } = {}) {
  const cls = { t: 'class', name, superclass: module ? null : superclass, module, methods: new Map(), consts: new Map(), includes: [], prepends: [], extended: [], cvars: new Map(), iv: new Map(), under, meta: null }
  it.epoch++
  return cls
}

// Defines a class or module as a constant of `under` (Object where none), by `Name` or `Outer::Name`.
export function define(it, path, superclass, options = {}) {
  const names = path.split('::')
  let under = options.under ?? it.cls.Object
  for (const name of names.slice(0, -1)) under = under.consts.get(name) ?? defineIn(it, under, name, null, { module: true })
  return under.consts.get(names.at(-1)) ?? defineIn(it, under, names.at(-1), superclass, options)
}
function defineIn(it, under, name, superclass, options) {
  const outer = under === it.cls.Object || under === undefined ? '' : `${under.name}::`
  const cls = newClass(it, `${outer}${name}`, options.module ? null : superclass ?? it.cls.Object, { ...options, under })
  under?.consts.set(name, cls)
  return cls
}

// A native method: `fn(it, self, args, block)`. Several names share one.
export function def(cls, names, fn, visibility = 'public') {
  for (const name of names.split(' ')) cls.methods.set(name, { name, fn, owner: cls, visibility })
}
export function metaOf(it, v) {
  if (v === null || typeof v !== 'object' || Object.isFrozen(v)) throw new RubyUnsupported('a singleton method of a value that takes none')
  if (!v.meta) {
    v.meta = newClass(it, `#<Class:${v.name ?? idOf(v)}>`, null)
    v.meta.attached = v
  }
  return v.meta
}
export function sdef(it, cls, names, fn) {
  def(metaOf(it, cls), names, fn)
}

// A class's ancestors, itself first: what is prepended, itself, what is included, the last first, and then its
// superclass's.
export function ancestors(it, cls) {
  if (cls.anc?.epoch === it.epoch) return cls.anc.list
  const list = []
  const add = (mod) => {
    for (const pre of mod.prepends.toReversed()) add(pre)
    if (!list.includes(mod)) list.push(mod)
    for (const inc of mod.includes.toReversed()) add(inc)
  }
  for (let at = cls; at; at = at.superclass) add(at)
  cls.anc = { epoch: it.epoch, list }
  return list
}

export function classOf(it, v) {
  if (v === null) return it.cls.NilClass
  if (v === true) return it.cls.TrueClass
  if (v === false) return it.cls.FalseClass
  if (typeof v === 'number') return it.cls.Integer
  if (v.t === 'obj') return v.cls
  if (v.t === 'class') return v.module ? it.cls.Module : it.cls.Class
  return it.cls[TAGS[v.t]]
}
const TAGS = { str: 'String', sym: 'Symbol', float: 'Float', arr: 'Array', hash: 'Hash', range: 'Range', proc: 'Proc', regexp: 'Regexp' }

// The classes a method of `v` is looked for in: its singleton class and what that is extended with, those of a
// class's superclasses, then its class's ancestors.
export function lookupChain(it, v) {
  const chain = []
  if (v !== null && typeof v === 'object') {
    for (let at = v; at; at = at.t === 'class' ? at.superclass : null) {
      if (at.meta) chain.push(...ancestors(it, at.meta))
      for (const mod of (at.extended ?? []).toReversed()) chain.push(...ancestors(it, mod))
    }
  }
  chain.push(...ancestors(it, classOf(it, v)))
  return chain
}

export function findMethod(it, v, name, after) {
  const chain = lookupChain(it, v)
  for (let i = after === undefined ? 0 : chain.indexOf(after) + 1; i < chain.length; i++) {
    const method = chain[i].methods.get(name)
    if (method !== undefined) return method.undefined ? undefined : method
  }
  return undefined
}

export const isA = (it, v, cls) => lookupChain(it, v).includes(cls)

// A constant by its name from where it is written: the modules it is nested in, the innermost first, then the
// ancestors of the innermost, then Object.
export function constOf(it, cref, name) {
  for (const mod of cref.toReversed()) if (mod.consts.has(name)) return mod.consts.get(name)
  for (const mod of ancestors(it, cref.at(-1) ?? it.cls.Object)) if (mod.consts.has(name)) return mod.consts.get(name)
  return it.cls.Object.consts.get(name)
}
export function constIn(it, mod, name) {
  for (const at of ancestors(it, mod)) if (at.consts.has(name)) return at.consts.get(name)
  return mod.module ? undefined : it.cls.Object.consts.get(name)
}
