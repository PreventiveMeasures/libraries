import { setTimeout as sleep } from 'node:timers/promises'

// What the browser says it loaded, which is a separate question from how it
// was launched (index.js) or what a turn looks like (wire.js). Debug-only:
// a scraper written against a page that cannot be exercised in tests is not
// something to fail requests on.

/* eslint-disable no-undef */
// What Chrome actually loaded, as opposed to which directory we pointed it
// at. Those are different questions: the execution override names a
// directory and does not steer the base model — model_version does, and this
// is where that shows.
//
// chrome://on-device-internals answers it under Broker State, in real tables
// rather than prose — Models is Name / Folder Size / Weights Path / Backend
// Type, Use Cases is Name / Requested / Unavailable Reason. Parsed as tables
// for that reason: a regex over the page text cannot say which column a value
// came from, and reading the wrong column is how this went wrong before.
//
// Reported, never enforced, and only under --debug: a scraper written against
// a page that cannot be exercised here is not something to fail requests on.
export async function reportLoadedModel(browser) {
  let page
  try {
    page = await browser.newPage()
    await page.goto('chrome://on-device-internals')
    const tables = await readTablesWhenReady(page)
    for (const name of ['Models', 'Use Cases', 'Assets']) {
      const rows = tables[name] ?? []
      // Row 0 is the header, so anything less is a table with no content.
      if (rows.length < 2) continue
      for (const row of rows.slice(1)) console.debug(`[chrome] ${name}: ${row.join(' | ')}`)
    }
    const log = (tables['Event Logs'] ?? []).slice(1).filter((r) => /model|load/iu.test(r.join(' ')))
    for (const row of log.slice(-4)) console.debug(`[chrome] log: ${row.at(-1)}`)
  } catch (err) {
    console.debug(`[chrome] could not read on-device-internals: ${err.message}`)
  } finally {
    await page?.close().catch(() => {})
  }
}

// Wait for the WebUI to render rather than for a fixed three seconds. This is
// awaited inline on the first turn, so a flat sleep put its whole duration in
// front of the answer the caller is waiting for; the tables are usually there
// in a fraction of it, and a page that never renders costs the ceiling once.
//
// The readiness check is the scrape itself, run again. waitForFunction was
// two wrong things at once: its options are its THIRD argument, so the
// timeout was landing as a page argument nothing read and the wait ran to
// playwright's own default instead of this ceiling — and its predicate
// searched the light DOM for tables that live in shadow roots, so it could
// only ever come back false. Asking the traversal that knows where they are
// cannot drift from what the scrape then finds.
const READY_MS = 3000
export async function readTablesWhenReady(page, { timeoutMs = READY_MS, pollMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const tables = await page.evaluate(readInternalsTables)
    // Row 0 is the header, so a table with one row has rendered but has
    // nothing in it yet.
    if (Object.values(tables).some((rows) => rows.length > 1) || Date.now() >= deadline) return tables
    await sleep(pollMs)
  }
}

// Runs in the page. Every <table> on it, keyed by the <h2> that introduces
// it, reached through the shadow roots the WebUI is built from.
function readInternalsTables() {
  const roots = []
  const collect = (root) => {
    roots.push(root)
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) collect(el.shadowRoot)
  }
  collect(document)
  // The <h2> that introduces a table is a previous sibling of the table or of
  // one of its ancestors, so walk outwards until one turns up.
  const headingFor = (table) => {
    for (let node = table; node; node = node.parentElement) {
      for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
        const h = sib.tagName === 'H2' ? sib : sib.querySelector?.('h2')
        if (h) return h.textContent.trim()
      }
    }
    return 'unnamed'
  }
  const rowsOf = (table) => [...table.querySelectorAll('tr')]
    .map((tr) => [...tr.querySelectorAll('th,td')].map((cell) => cell.textContent.trim()))
    .filter((cells) => cells.length > 0)

  const out = {}
  for (const root of roots) {
    for (const table of root.querySelectorAll('table')) out[headingFor(table)] = rowsOf(table)
  }
  return out
}
/* eslint-enable no-undef */
