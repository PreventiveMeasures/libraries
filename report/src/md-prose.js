import { closesFence, markdownBlockOpener } from './md-fence.js'

function frame() {
  return { items: [], lazy: false, quoted: false, fresh: false, marker: '', html: null, inside: 0, childMargin: 0 }
}

// Walk containers on each line with an explicit stack. Every quote marker is
// consumed once; neither call-stack depth nor rescanning depends on nesting.
// Structural splitters keep their existing fence/identity contract separately.
export function withoutMarkdownCodeBlocks(text) {
  const frames = [frame()], prose = []
  for (const raw of text.split('\n')) {
    let columns = 0
    const parts = raw.split('\t')
    for (let i = 0; i < parts.length - 1; i++) {
      columns += parts[i].length
      const spaces = 4 - columns % 4
      columns += spaces
      parts[i] += ' '.repeat(spaces)
    }
    const line = parts.join('')
    let depth = 0, offset = 0, result
    for (;;) {
      result = readLine(frames[depth], line.slice(offset))
      if (result.kind !== 'quote') break
      if (result.reset) frames.length = depth + 1
      offset += result.width
      depth++
      frames[depth] ??= frame()
    }
    // A lazy continuation retains the quoted paragraph's container state.
    if (result.kind !== 'lazy') frames.length = depth + 1
    for (let i = depth - 1; i >= 0; i--) frames[i].lazy = frames[depth].lazy
    prose.push(result.kind === 'code' ? '' : line.slice(offset))
  }
  return prose.join('\n')
}

function readLine(state, line) {
  const indent = /^ */u.exec(line)[0].length
  if (state.marker || state.html) {
    const left = state.inside > 0 && line.trim() !== '' && indent < state.inside
    const html = state.html
    const closes = !left && (html ? html.test(line) : indent <= state.inside + 3 && closesFence(state.marker, line))
    if (left || closes) { state.marker = ''; state.html = null }
    if (!left) return { kind: html ? 'prose' : 'code' }
  }
  if (!line.trim()) {
    if (state.fresh) state.items.pop()
    state.fresh = state.lazy = state.quoted = false
    return { kind: 'prose' }
  }
  let depth = state.items.length
  while (depth > 0 && indent < state.items[depth - 1]) depth--
  let margin = depth > 0 ? state.items[depth - 1] : 0
  let rest = line.slice(margin)
  let opens = markdownBlockOpener(rest, state.lazy, depth === state.items.length && !state.quoted)
  if (state.lazy && !opens) return { kind: 'lazy' }
  state.items.length = depth
  const newItem = Boolean(opens?.item)
  while (opens?.item) {
    margin += opens.item
    rest = rest.slice(opens.item)
    state.items.push(margin)
    opens = markdownBlockOpener(rest, false)
  }
  state.fresh = rest.trim() === ''
  const quote = /^ {0,3}> ?/u.exec(rest)
  const reset = newItem || !state.quoted || state.childMargin !== margin
  state.quoted = Boolean(quote)
  if (quote) {
    state.childMargin = margin
    return { kind: 'quote', width: margin + quote[0].length, reset }
  }
  const indented = /^ {4}/u.test(rest)
  state.lazy = !opens && !state.fresh && !indented
  if (opens?.fence) { state.marker = opens.fence; state.inside = margin }
  else if (opens?.html) { state.html = opens.html.test(rest) ? null : opens.html; state.inside = margin }
  return { kind: indented || opens?.fence ? 'code' : 'prose' }
}
