#!/usr/bin/env node
// Rewrite every stored history under a cache directory in the slim form the writers use now: entry
// 0 keeps its request and its `messages` snapshot, every later entry keeps neither. Files written
// before that landed carry one snapshot per turn, each holding every message ahead of it, so a long
// tool session left a file that grew with the square of its length. Nothing rewrites an entry that
// is never asked for again, which is what this is for.
// Not part of the published package; run it as `scripts/normalize-cache.js <dir>`, or with
// `--dry-run` first to see what it would come to.

import { opendir } from 'node:fs/promises'
import process from 'node:process'
import { parseArgs, styleText } from 'node:util'

import { normalizeCache, setProvider } from '../index.js'

const USAGE = `Usage: scripts/normalize-cache.js [options] <cache-dir>

Rewrites every stored history under <cache-dir>, dropping the per-turn message snapshots that a
resume rebuilds anyway. Nothing is written until the slim text has been read back and shown to
replay to exactly the messages the old file recorded, so a file that would lose something is
reported and left alone.

The replay runs through a provider's adapter, so each file is normalized under the provider that
wrote it — read from the entries themselves. That provider has to be one this process can select,
which for most means its API key in the environment; files whose provider cannot be selected are
left alone and counted.

Rewrites each file in place, with no lock and no backup. Point it at a cache nothing is writing: a
run with \`partial\` enabled rewrites its entry after every turn, and one that lands between the
read and the rewrite is refused rather than reverted — the file is left alone and counted.

  -n, --dry-run          do everything but the write, and report what a real
                         run would have done
      --provider <name>  use this provider for every file, whatever the entries
                         say. For a cache whose stamps predate them.
  -q, --quiet            only the summary and what it could not do
  -h, --help             show this message

Exits non-zero when any file was left alone, whether because it would have lost something or
because its provider could not be selected.
`

// A provider this process cannot select is not a file that failed — it is a file nobody looked at.
class Unselectable extends Error {}

const say = (line) => process.stdout.write(`${line}\n`)
// Everything the summary does not account for goes to stderr, so a piped report stays a report.
const warn = (line) => process.stderr.write(`${line}\n`)
// styleText decides whether to colour by asking process.stdout unless told otherwise, and every
// styled string below this line is written to stderr. The two redirect independently, so asking the
// wrong one writes escape codes into a `2> report.txt` whenever a terminal is still on stdout, and
// strips them from the warnings a person is watching whenever stdout is the thing redirected.
const mark = (colour, text) => styleText(colour, text, { stream: process.stderr })
const kb = (n) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

// Which adapter each file's own stamp asks for. The failures are held per name so that a provider
// this process cannot select is reported once rather than once per file, and `current` is what is
// actually selected — so nothing here depends on the walk grouping providers together.
function providerPicker(override) {
  const unusable = new Map()
  let warnedUnstamped = false
  let current
  return (stamp) => {
    const name = override ?? stamp?.split(':')[0]
    if (!name) {
      if (!warnedUnstamped) {
        warnedUnstamped = true
        warn(`${mark('yellow', 'skip')} entries with no provider stamp — pass --provider to say which wrote them`)
      }
      throw new Unselectable('the entries name no provider')
    }
    if (unusable.has(name)) throw new Unselectable(unusable.get(name))
    if (name === current) return
    try {
      setProvider(name)
      current = name
    } catch (err) {
      unusable.set(name, err.message)
      warn(`${mark('yellow', 'skip')} provider ${name}: ${err.message}`)
      throw new Unselectable(err.message)
    }
  }
}

async function main(argv) {
  let positionals, values
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: {
        'dry-run': { type: 'boolean', short: 'n' },
        provider: { type: 'string' },
        quiet: { type: 'boolean', short: 'q' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
    }))
  } catch (err) {
    process.stderr.write(`normalize-cache.js: ${err.message}\n\n${USAGE}`)
    return 1
  }
  if (values.help || positionals.length !== 1) {
    process.stdout.write(USAGE)
    return values.help ? 0 : 1
  }

  // The walk treats a directory it cannot read as an empty one, which is right for a subdirectory
  // that vanished mid-run and wrong for the argument: a typo should say so rather than report that
  // a cache of nothing needed nothing.
  const dir = positionals[0]
  try {
    // Awaited: `close()` returns a promise, and dropping it leaves the handle open until it settles
    // and a rejection from it unhandled — which on this Node is a process-level crash, mid-walk,
    // with a stack pointing nowhere near here.
    await (await opendir(dir)).close()
  } catch (err) {
    process.stderr.write(`normalize-cache.js: cannot read ${dir}: ${err.message}\n`)
    return 1
  }

  const dryRun = values['dry-run']
  const totals = { normalized: 0, unchanged: 0, skipped: 0, unselectable: 0, failed: 0, before: 0, after: 0 }
  const selectProvider = providerPicker(values.provider)
  for await (const { path, status, before, after, error } of normalizeCache(dir, { dryRun, selectProvider })) {
    if (error instanceof Unselectable) {
      totals.unselectable += 1
    } else if (error) {
      totals.failed += 1
      // The layer names the file in what it asserts; anything else — a read error, a write error —
      // arrives bare, and the path is the first thing an operator needs.
      warn(`${mark('red', 'keep')} ${error.message.includes(path) ? error.message : `${path}: ${error.message}`}`)
    } else {
      totals[status] += 1
      totals.before += before
      totals.after += after
      if (status === 'normalized' && !values.quiet) {
        const label = dryRun ? styleText('cyan', 'dry') : styleText('green', 'ok ')
        say(`${label}  ${path}: ${kb(before)} -> ${kb(after)}`)
      }
    }
  }

  const saved = totals.before - totals.after
  say(
    `\n${totals.normalized} ${dryRun ? 'to normalize' : 'normalized'}, ${totals.unchanged} already slim, `
    + `${totals.skipped} not a history, `
    + `${totals.unselectable} whose provider could not be selected, ${totals.failed} left alone\n`
    + `${kb(totals.before)} -> ${kb(totals.after)}${saved > 0 ? ` (${kb(saved)} back)` : ''}`
    + `${dryRun ? ' — nothing was written' : ''}`,
  )
  // Either count means the run did not finish the job, for a reason worth reading.
  return totals.failed + totals.unselectable > 0 ? 1 : 0
}

process.exitCode = await main(process.argv.slice(2))
