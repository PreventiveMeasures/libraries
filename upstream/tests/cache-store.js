// A caller's cache store over a Map, keeping a copy of what it is given by
// type and key, as a database would: `copy` makes it, a JSON round trip by
// default, as most keep values; structuredClone keeps bytes as bytes.
// `log` is every read and write; `get` and `set` reach the entries behind
// its back.
const viaJson = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

export function mapStore(copy = viaJson) {
  const entries = new Map()
  const log = []
  const at = (type, key) => JSON.stringify([type, key])
  return {
    log,
    get: (type, key) => entries.get(at(type, key)),
    set: (type, key, value) => entries.set(at(type, key), copy(value)),
    read(type, key) {
      log.push(['read', type, key])
      return Promise.resolve(copy(entries.get(at(type, key))))
    },
    write(type, key, value) {
      log.push(['write', type, key])
      entries.set(at(type, key), copy(value))
      return Promise.resolve()
    },
  }
}
