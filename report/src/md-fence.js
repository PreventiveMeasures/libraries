// Where fenced code is in a markdown text, as CommonMark reads it — the
// question every structural splitter asks before taking a line for a
// `## ` heading or a `| ` row. Its own module because answering it
// means following what holds a fence: list items, and the HTML blocks
// that hold none. md-structure.js re-exports all of it.

// Byte ranges of fenced code blocks (``` / ~~~), fences included, read
// once per text so no structural splitter takes a code line for a `## `
// heading or a `| ` row. A fence is a run of three or more of one
// character, and only a run of that character at least as long, with
// nothing after it, closes it (closesFence) — so a ```` block holds a
// ``` example whole, and a ```js line inside a ``` block is code. A
// backtick fence's info string holds no backtick, so a line opening on
// ```x``` is inline code, not a fence. A dangling fence runs to end of
// input — the reading markdown gives.
//
// A fence may be INDENTED: three spaces at the top level (markdown's
// own limit, past which a line is indented code), and three past the
// text of the list item it sits in, which is how a snippet under a
// numbered step is written. So the open items are tracked, each by the
// column its text starts at — a `10.` or a nested bullet pushes it out
// — and a line is in every item whose text it starts at or past. That
// keeps a block indented FURTHER than its item's text an indented code
// block, with its ``` lines content, and ends a fence with its item.
//
// Nor is anything inside an HTML block markdown: a ``` in a comment or
// a <div> opens no fence. Those are tracked too, by how they end.
const FENCE_RE = /^( *)(`{3,}|~{3,})(.*)$/u
// A line that interrupts a paragraph — an ATX heading, a quote, a
// thematic break — and so can't continue one lazily (fences, HTML
// blocks and list markers are asked about apart).
const INTERRUPT_RE = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|>|([-*_])(?:[ \t]*\1){2,}[ \t]*$)/u
const THEMATIC_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/u
// A setext underline, which makes the paragraph above it a heading.
const SETEXT_RE = /^ {0,3}(?:=+|-+)[ \t]*$/u
// A list marker and the gap to its text; `m[0].length` is the column
// the item's continuation lines are indented to.
export const LIST_MARKER_RE = /^( *)(?:[-*+]|\d{1,9}[.)]) +(?=\S)/u
// A list marker with nothing after it: an empty item, whose text — on
// the lines below — starts a column past the marker.
const EMPTY_ITEM_RE = /^ *(?:[-*+]|\d{1,9}[.)])[ \t]*$/u

// CommonMark's HTML blocks, each opener with what ends it and the text
// that would: the first five end on a line holding their closer (which
// may be the opening line), the sixth at a blank line. The seventh — a
// lone complete tag — also ends at a blank line, but can't interrupt a
// paragraph.
//
// A declaration opens on `<!` and any letter since CommonMark 0.30; GFM,
// which GitHub renders, keeps 0.29's capital. So one is closed with a
// comment, not a bare `>`: the comment holds the `>` that ends it where
// it is open, and is nothing where `<!doctype` was text — where a `>`
// line would be an empty quote.
const BLANK_RE = /^\s*$/u
const HTML_BLOCKS = [
  [/^<(script|pre|textarea|style)(?:\s|>|$)/iu, /<\/(?:script|pre|textarea|style)>/iu, (m) => `</${m[1].toLowerCase()}>`],
  [/^<!--/u, /-->/u, '-->'],
  [/^<\?/u, /\?>/u, '?>'],
  [/^<![A-Za-z]/u, />/u, '<!-- -->'],
  [/^<!\[CDATA\[/u, /\]\]>/u, ']]>'],
  [/^<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|section|search|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|\/?>|$)/iu, BLANK_RE, null],
]
const HTML_TAG_LINE_RE = /^(?:<[A-Za-z][\dA-Za-z-]*(?:\s+[:A-Z_a-z][\w.:-]*(?:\s*=\s*(?:[^\s"'<=>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][\dA-Za-z-]*\s*>)\s*$/u

// What `rest` — a line read from its block's margin — opens: a fence
// (its run), an HTML block (what ends it, and the closing text if a
// line can close it rather than a blank one), a list item (the width of
// its marker, to where its text starts) or another block that ends a
// paragraph (`true`); null for text. With a paragraph open, only what
// may interrupt one counts: a lone tag is then the paragraph's text,
// lazily or not; and when the line is in the paragraph's own block
// (`within`), not short of it, an ordered item has to start at 1, and a
// setext underline ends the paragraph as a heading — lazily, it's text.
function opener(rest, paragraph, within = paragraph) {
  const lead = /^ */u.exec(rest)[0].length
  if (lead > 3) return null
  if (paragraph && within && SETEXT_RE.test(rest)) return true
  const fence = FENCE_RE.exec(rest)
  if (fence && !(fence[2][0] === '`' && fence[3].includes('`'))) return { fence: fence[2] }
  const tag = rest.slice(lead)
  for (const [open, ends, close] of HTML_BLOCKS) {
    const m = open.exec(tag)
    if (m) return { html: ends, close: typeof close === 'function' ? close(m) : close }
  }
  if (!paragraph && HTML_TAG_LINE_RE.test(tag)) return { html: BLANK_RE, close: null }
  const item = THEMATIC_RE.test(rest) ? null : LIST_MARKER_RE.exec(rest)
  if (item && !(paragraph && within && /^ *(?:\d*[02-9]|\d+\d)[.)]/u.test(item[0]))) {
    // Five spaces or more after the marker are one, and indented code.
    const gap = / +$/u.exec(item[0])[0].length
    return { item: gap > 4 ? item[0].length - gap + 1 : item[0].length }
  }
  // An empty item can't interrupt a paragraph.
  const empty = THEMATIC_RE.test(rest) || (paragraph && within) ? null : EMPTY_ITEM_RE.exec(rest)
  if (empty) return { item: empty[0].trimEnd().length + 1 }
  return INTERRUPT_RE.test(rest) || null
}

export function fenceRanges(text) {
  return readFences(text).ranges
}

// Whether a quoted line holds paragraph text, past its `>`s and any
// list markers inside — `paragraph` if one is already open there.
function quotedText(line, paragraph) {
  let text = line.replace(/^(?: {0,3}> ?)+/u, '')
  let opens = opener(text, paragraph)
  while (opens?.item) {
    text = text.slice(opens.item)
    opens = opener(text, false)
  }
  return text.trim() !== '' && !opens && /^ */u.exec(text)[0].length < 4
}

// fenceRanges, and the line that would close what the text leaves open
// at its end — a fence, or an HTML block a line can end — at the margin
// of the item it sits in; null when nothing such is open.
export function readFences(text) {
  const ranges = []
  // The open fence, by where it began and its run; or the open HTML
  // block, by what ends it and the text that would; and the margin of
  // the item either sits in, 0 at the top level.
  let open = -1
  let marker = ''
  let html = null
  let inside = 0
  // The open list items, innermost last, each by the column its text
  // starts at.
  const items = []
  // Whether the line before was paragraph text, which the next line of
  // text continues wherever it starts. Nothing else is continued so: a
  // blank line, a fence, a heading or an indented code block ends it.
  // And whether that paragraph is a quote's, which a line without the
  // quote's `>` only ever continues lazily.
  let lazy = false
  let quoted = false
  // Whether the line before opened an empty item, which a blank line
  // ends: an item starts with one blank line at most.
  let fresh = false
  let pos = 0
  for (const line of text.split('\n')) {
    const start = pos
    pos += line.length + 1
    const indent = /^ */u.exec(line)[0].length
    if (open !== -1 || html) {
      // A fence or HTML block in a list item ends with the item, closed
      // or not: a line starting LEFT of the item's text has left it — a
      // fence line too, which can't close what is no longer open — and
      // only a paragraph continues lazily. That line is read afresh
      // below, so a step whose snippet lost its closing fence doesn't
      // take the headings after it with it.
      const left = inside > 0 && line.trim() !== '' && indent < inside
      // A closing fence sits within three columns of the fence's
      // margin, as an opening one does, and needn't match the opening
      // one's indent — but its RUN has to, so a ``` inside a ~~~ or a
      // ```` block stays content.
      const closes = !left && (html ? html.ends.test(line) : indent <= inside + 3 && closesFence(marker, line))
      if (left || closes) {
        if (open !== -1) ranges.push([open, left ? start - 1 : start + line.length])
        open = -1
        html = null
      }
      if (!left) continue
    }
    // A blank line ends a paragraph and no item: a loose list is still
    // one list.
    if (!line.trim()) {
      if (fresh) items.pop()
      fresh = false
      lazy = false
      continue
    }
    // The items the line stays in, and what it holds read from the
    // innermost one's margin.
    let depth = items.length
    while (depth > 0 && indent < items[depth - 1]) depth--
    let margin = depth > 0 ? items[depth - 1] : 0
    let rest = line.slice(margin)
    // Plain text straight under a paragraph continues it — lazily if it
    // starts short of the paragraph's item — and every item stands.
    // Anything else leaves the items it starts short of.
    let opens = opener(rest, lazy, depth === items.length && !quoted)
    if (lazy && !opens) continue
    items.length = depth
    // Markers open items, each in the last ("- 1. x" opens two), and
    // what follows is read from the innermost one's margin.
    while (opens?.item) {
      margin += opens.item
      rest = rest.slice(opens.item)
      items.push(margin)
      opens = opener(rest, false)
    }
    fresh = rest.trim() === ''
    if (opens?.fence) [open, marker, inside] = [start, opens.fence, margin]
    else if (opens?.html) [html, inside] = [opens.html.test(rest) ? null : { ends: opens.html, close: opens.close }, margin]
    // Paragraph text or not: not a heading, rule or anything opened
    // above, and not four columns in, which is indented code — and for a
    // quote, what it holds past its `>` and any markers, whose paragraph
    // continues lazily too. That is all a quote is read for: its own
    // fences aren't followed (a quoted line is never one of the
    // document's, and the quote's end ends them), nor the items inside
    // it, so whether a line short of such an item still reaches its
    // paragraph — to underline it, or start a list — is taken as yes.
    const inQuote = lazy && quoted
    quoted = /^ {0,3}>/u.test(rest)
    lazy = quoted ? quotedText(rest, inQuote) : !opens && !fresh && /^ */u.exec(rest)[0].length < 4
  }
  if (open !== -1) ranges.push([open, text.length])
  const close = open === -1 ? html?.close : marker
  return { ranges, closer: close ? ' '.repeat(inside) + close : null }
}

// Whether `line` closes a fence opened with the run `marker`: the same
// character, a run at least as long, and nothing after it but spaces —
// a closing fence carries no info string. Indentation is the caller's.
export function closesFence(marker, line) {
  const fence = FENCE_RE.exec(line)
  return fence !== null && fence[2][0] === marker[0] && fence[2].length >= marker.length && !fence[3].trim()
}

// Whether `index` is in one of fenceRanges' ranges. They come sorted and
// disjoint, each end exclusive, so the first to end past `index` is the
// only one that can hold it — found by halving, since the splitters ask
// per line or per match, and a scan of every range per question was
// quadratic in the fences.
export function inFence(ranges, index) {
  let lo = 0
  let hi = ranges.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (ranges[mid][1] <= index) lo = mid + 1
    else hi = mid
  }
  return lo < ranges.length && index >= ranges[lo][0]
}
