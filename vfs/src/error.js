const STRERROR = {
  __proto__: null,
  ENOENT: 'No such file or directory',
  ENOTDIR: 'Not a directory',
  EISDIR: 'Is a directory',
  EEXIST: 'File exists',
  ENOTEMPTY: 'Directory not empty',
  ELOOP: 'Too many levels of symbolic links',
  EINVAL: 'Invalid argument',
  EPERM: 'Operation not permitted',
  EBUSY: 'Device or resource busy',
  EILSEQ: 'Invalid or incomplete multibyte or wide character',
  ENAMETOOLONG: 'File name too long',
}

// What a path may not carry into a message as it is: a control, which a
// terminal acts on, a line or paragraph separator, and a bidirectional
// control, which reorders what is shown about it. Each is spelled as an
// escape instead, as archive spells a name in its messages.
const UNSHOWN = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu
const shown = (path) => `${path}`.replaceAll(UNSHOWN, (char) => `\\u${char.codePointAt(0).toString(16).padStart(4, '0')}`)

// What a caller gets for an argument of the wrong type, named by what it is.
export const wrongType = (what, value, expected = 'a string') => new TypeError(`${what} must be ${expected}, not ${value === null ? 'null' : typeof value}`)

// `code` is the POSIX errno name; the message is the line a shell prints,
// and `path` the path as it was given.
export class VfsError extends Error {
  constructor(code, path) {
    super(`${shown(path)}: ${STRERROR[code] ?? code}`)
    this.name = 'VfsError'
    this.code = code
    this.path = path
  }
}
