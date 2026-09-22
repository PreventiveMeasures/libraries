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
}

// `code` is the POSIX errno name; the message is the line a shell prints.
export class VfsError extends Error {
  constructor(code, path) {
    super(`${path}: ${STRERROR[code]}`)
    this.name = 'VfsError'
    this.code = code
    this.path = path
  }
}
