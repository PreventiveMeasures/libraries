#!/usr/bin/env node
// The pipeline by hand, against any provider the layer knows: build the table for a task over a
// dataset, then select for a request. Not part of the published package; run it as
// `scripts/grid.js build ...` and `scripts/grid.js select ...`.

import { readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { parseArgs, styleText } from 'node:util'
import {
  DEFAULT_MODEL, closeProvider, isRecognizedModel, resolveModel, resolveThinkEffort, setCacheDir, setFetchConcurrency,
  setProvider, supportedModels, validateModel,
} from '@preventive/ai'
import { buildTable, select } from '../index.js'

const USAGE = `Usage: scripts/grid.js build  --task <task.json> --entries <entries.jsonl> --out <table.json>
       scripts/grid.js select --table <table.json> --request <request.txt> [--top <n>]

build compacts every entry for the task and writes the table; select ranks the dataset's entries
for one request against a table. Both read the response cache, so a rerun of either is free.

  task.json      {"id":"...","prompt":"...","question":"..."}
  entries.jsonl  one {"id":"...","text":"..."} per line
  request.txt    the request entry's text (--id names it; the file name when omitted)

  -m, --model <id>      build: the model (default: ${DEFAULT_MODEL})
      --strong <id>     select: the gate's and the finalists' model (default: --model)
      --search <id>     select: the page model (default: --strong)
      --cheap <id>      select: the whole-dataset model (default: --search)
  -p, --provider <name> anthropic, openai, openrouter, moonshot, ollama, chrome. When omitted, the
                        first that serves every model of the run: the models' own, then openrouter,
                        then ollama
      --free            allow :free endpoints, which are OpenRouter's; without it a :free model is
                        refused, and with it every other model is
      --cache-dir <dir> the response cache (default: ./grid-cache)
      --concurrency <n> calls in flight at once (default: 20)
      --top <n>         select: how many results to print (default: all finalists)
      --final <frac>    select: the fraction of the table read in full (default: 0.01)
      --no-gate         select: skip the gate and search the summaries alone
      --think           enable thinking
      --effort <level>  low, medium, high, xhigh, max
      --json            select: print the full result as JSON
  -h, --help            show this message
`

const PROVIDER_FOR = { anthropic: 'anthropic', chrome: 'chrome', moonshotai: 'moonshot', openai: 'openai' }

// Whether a provider serves a model, by the layer's own listing: a namespace's adapter reaches
// most of its rows but not all (a row marked OpenRouter-only), OpenRouter reaches every hosted row
// of every namespace and, with --free, the free endpoints, and Ollama the local builds its tag
// table maps. Listed once per provider and mode asked about. The providers the layer can list;
// a gateway is not one, since what it routes is the operator's to know.
const LISTED = new Set(['anthropic', 'openai', 'openrouter', 'ollama', 'chrome', 'moonshot'])
const served = new Map()
function serves(provider, id, free) {
  const key = `${provider}\u0000${free}`
  if (!served.has(key)) served.set(key, new Set(supportedModels({ provider, free }).map((row) => row.id)))
  return served.get(key).has(id)
}

// Thrown rather than exited: main() is the one place the process ends, after the provider has been
// closed on the way out. An exit from inside a command skips that finally, and the chrome provider
// would be left holding a browser open.
const fail = (message) => { throw new Error(message) }
const note = (message) => process.stderr.write(styleText('dim', message) + '\n')

const readJSON = (path) => JSON.parse(readFileSync(path, 'utf8'))
const readLines = (path) => readFileSync(path, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))

function parse(argv) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'cache-dir': { type: 'string' },
      cheap: { type: 'string' },
      concurrency: { type: 'string' },
      effort: { type: 'string' },
      entries: { type: 'string' },
      final: { type: 'string' },
      free: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      id: { type: 'string' },
      json: { type: 'boolean' },
      model: { type: 'string', short: 'm' },
      'no-gate': { type: 'boolean' },
      out: { type: 'string' },
      provider: { type: 'string', short: 'p' },
      request: { type: 'string' },
      search: { type: 'string' },
      strong: { type: 'string' },
      table: { type: 'string' },
      task: { type: 'string' },
      think: { type: 'boolean' },
      top: { type: 'string' },
    },
  })
}

const number = (value, name, fallback) => {
  if (value === undefined) return fallback
  if (!/^\d+(?:\.\d+)?$/u.test(value)) fail(`--${name} takes a number, got ${value}`)
  return Number(value)
}

// A count: whole, since a fraction of a result would be silently truncated where it is used.
const whole = (value, name) => {
  const count = number(value, name)
  if (!Number.isInteger(count)) fail(`--${name} takes a whole number, got ${value}`)
  return count
}

function report(tally, elapsed) {
  const { usage, calls, hits, misses } = tally
  note(`${(elapsed / 1000).toFixed(1)}s  calls=${calls} cache hits=${hits} misses=${misses}  in=${usage.input} out=${usage.output} cacheRead=${usage.cacheRead}  $${usage.cost.toFixed(4)}`)
}

async function build(values, common) {
  if (!values.task || !values.entries || !values.out) fail(`build needs --task, --entries and --out\n\n${USAGE}`)
  const task = readJSON(values.task)
  const entries = readLines(values.entries)
  const started = Date.now()
  let last = 0
  const { focus, questions, rows, tally } = await buildTable({
    ...common, task, entries, model: common.model,
    onRow: (row, done, total) => {
      if (done - last >= 100 || done === total) { last = done; note(`compacted ${done}/${total}`) }
    },
  })
  note(`focus: ${focus}`)
  for (const q of questions) note(`${q.id}. ${q.text}`)
  writeFileSync(values.out, JSON.stringify({ task, focus, questions, rows }))
  note(`wrote ${rows.length} rows to ${values.out}`)
  report(tally, Date.now() - started)
}

async function selectOne(values, common) {
  if (!values.table || !values.request) fail(`select needs --table and --request\n\n${USAGE}`)
  // The flags before the files: a flag that cannot be read is the caller's to fix first.
  const topK = values.top === undefined ? undefined : whole(values.top, 'top')
  const final = number(values.final, 'final', 0.01)
  const table = readJSON(values.table)
  const request = { id: values.id ?? values.request, text: readFileSync(values.request, 'utf8').trim() }
  const started = Date.now()
  const result = await select({ ...common, ...table, request, topK, final, useGate: !values['no-gate'] })
  const { results, gate, stages, fullStages, tally } = result
  if (gate.reason) note(`gate: ${gate.reason}${gate.extraQuestions.length ? ` (+${gate.extraQuestions.length} columns)` : ''}${gate.fullScan ? ' (full scan)' : ''}`)
  for (const s of [...stages, ...fullStages]) note(`stage ${s.stage}: ${s.rows} rows -> ${s.survivors} over ${s.pages} pages`)
  if (values.json) {
    process.stdout.write(JSON.stringify({ request: request.id, results, gate, stages, fullStages }, null, 2) + '\n')
  } else {
    for (const { id, score, votes, reason } of results) process.stdout.write(`${String(score).padStart(3)}  ${id}  (votes ${votes})  ${reason}\n`)
  }
  report(tally, Date.now() - started)
}

async function main(argv) {
  try {
    await cli(argv)
  } catch (err) {
    process.stderr.write(`grid.js: ${err.message}\n`)
    process.exit(2)
  }
}

async function cli(argv) {
  let parsed
  try { parsed = parse(argv) } catch (err) { fail(`${err.message}\n\n${USAGE}`) }
  const { values, positionals } = parsed
  if (values.help) { process.stdout.write(USAGE); return }
  const command = positionals[0]
  if (command !== 'build' && command !== 'select') fail(`expected build or select\n\n${USAGE}`)

  // Aliases resolved at the boundary, as ai's own script does, so an id reaches the layer under the
  // row that prices and caps it, and the provider is inferred from the namespace that row carries.
  const model = resolveModel(values.model ?? DEFAULT_MODEL)
  const strong = resolveModel(values.strong ?? model)
  const models = { strong, search: resolveModel(values.search ?? strong), cheap: resolveModel(values.cheap ?? values.search ?? strong) }
  // One provider serves a whole run (the layer's is process-wide), so it is inferred from the
  // models the command will actually send -- select's three, not the --model they default from, and
  // without the cheap one when --no-gate leaves nothing for it to do.
  const sent = command === 'build' ? [model] : values['no-gate'] ? [models.strong, models.search] : Object.values(models)
  const used = [...new Set(sent)]
  const free = Boolean(values.free)
  for (const id of used) {
    // A typo would otherwise reach the wire as an unknown id and come back as a provider error.
    if (!isRecognizedModel(id)) fail(`unknown model ${id}; check the spelling, or add a row for it to ai's model table`)
    // The layer's own gate on free endpoints and retired models, with its own wording.
    try { validateModel(id, { free }) } catch (err) { fail(err.message) }
    // --think on a model that cannot reason, or --effort without --think, is refused here by name
    // rather than dropped on the way to the wire, which is what the pipeline's own normalisation
    // would do for a run that mixes models.
    try { resolveThinkEffort(id, values.think, values.effort) } catch (err) { fail(`${err.message} (${id})`) }
  }
  // The provider named, else the first of the models' own, OpenRouter and Ollama that serves every
  // model of the run: a row its namespace's adapter does not reach goes through OpenRouter, and so
  // does a run that mixes namespaces; a local build no hosted route serves goes to Ollama. A bare
  // id that is both a hosted row and an Ollama tag is the hosted one, so ollama has to be named for
  // it, as ai's own script says. Nothing serving them all is refused rather than guessed.
  const candidates = [...new Set([...used.map((id) => PROVIDER_FOR[id.split('/')[0]]).filter(Boolean), 'openrouter', 'ollama'])]
  const provider = values.provider ?? candidates.find((name) => used.every((id) => serves(name, id, free)))
  if (!provider) fail(`no one provider serves ${used.join(', ')}; name --provider`)
  // A provider named by hand is held to the same listing, where the layer has one: a pair it would
  // refuse on the wire is refused here, by the model's name, before anything is sent.
  if (values.provider !== undefined && LISTED.has(provider)) {
    const unserved = used.filter((id) => !serves(provider, id, free))
    if (unserved.length > 0) fail(`--provider ${provider} does not serve ${unserved.join(', ')}`)
  }
  // Whole and at least one, since it sizes the transport queue too: a queue of zero capacity hands
  // out no slot, and every request of the run waits for one forever.
  const concurrency = number(values.concurrency, 'concurrency', 20)
  if (!Number.isInteger(concurrency) || concurrency < 1) fail(`--concurrency takes a whole number of at least 1, got ${values.concurrency}`)
  setCacheDir(values['cache-dir'] ?? './grid-cache')
  setFetchConcurrency(concurrency)
  setProvider(provider)

  const common = { model, models, concurrency, think: Boolean(values.think), effort: values.effort }
  // Always, whatever the command threw: the chrome provider holds a browser open, and without this
  // the process would exit around it.
  try {
    if (command === 'build') await build(values, common)
    else await selectOne(values, common)
  } finally {
    await closeProvider()
  }
}

await main(process.argv.slice(2))
