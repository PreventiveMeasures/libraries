import { EMPTY } from './bytes.js'
import { ArchiveError } from './error.js'
import { checkString, quote } from './text.js'

export const DEFAULT_MODE = { file: 0o644, directory: 0o755, symlink: 0o777 }

export const isFile = (type) => type === 'file' || type === 'contiguous-file'

// The name as stored: a directory's with its slash
export const wireName = (entry) => (entry.type === 'directory' ? `${entry.name}/` : entry.name)

// The fields both formats share, checked; `types` has a key for each type the format writes
export function checkEntry(entry, types) {
  if (entry === null || typeof entry !== 'object') throw new ArchiveError('an entry is not an object')
  const type = entry.type ?? 'file'
  // Before Object.hasOwn, which would take anything that stringifies to a type
  if (typeof type !== 'string') throw new ArchiveError('entry type is not a string')
  if (!Object.hasOwn(types, type)) throw new ArchiveError(`entry type ${quote(type)} is not one this package writes`)
  const { name } = entry
  checkString(name, 'entry name')
  const data = entry.data ?? EMPTY
  if (!(data instanceof Uint8Array)) throw new ArchiveError(`data of ${quote(name)} is not a Uint8Array`)
  if (data.length !== 0 && !isFile(type)) throw new ArchiveError(`a ${type} cannot carry data (${quote(name)})`)
  const linkname = entry.linkname ?? ''
  checkString(linkname, `link target of ${quote(name)}`)
  if (linkname !== '' && type !== 'hardlink' && type !== 'symlink') throw new ArchiveError(`a ${type} cannot have a link target (${quote(name)})`)
  return { name, type, data, linkname }
}
