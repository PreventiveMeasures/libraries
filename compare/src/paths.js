// A rename written as `git diff --stat` writes one: the directories both share,
// what changed, and the rest.

export function renameParts(from, to, { extension = true } = {}) {
  const a = from.split('/'), b = to.split('/')
  let head = 0
  while (head < a.length - 1 && head < b.length - 1 && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head - 1 && tail < b.length - head - 1 && a.at(-1 - tail) === b.at(-1 - tail)) tail++
  const parts = {
    head: head ? `${a.slice(0, head).join('/')}/` : '',
    from: a.slice(head, a.length - tail).join('/'),
    to: b.slice(head, b.length - tail).join('/'),
    tail: tail ? `/${a.slice(-tail).join('/')}` : '',
  }
  const dot = parts.from.lastIndexOf('.')
  if (extension && !parts.from.includes('/') && !parts.to.includes('/') && dot > 0
      && parts.to.lastIndexOf('.') === dot && parts.from.slice(0, dot) === parts.to.slice(0, dot)) {
    return { ...parts, head: parts.head + parts.from.slice(0, dot), from: parts.from.slice(dot), to: parts.to.slice(dot) }
  }
  return parts
}
