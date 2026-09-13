#!/usr/bin/env node
// One prompt, one answer, against any provider the layer knows — the small
// harness that makes `chrome` testable by hand, and every other provider
// comparable against it in the same breath.
// Not part of the published package; run it as `scripts/chat.js "prompt"`.

import { readFileSync } from 'node:fs'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import { parseArgs, styleText } from 'node:util'
import {
  DEFAULT_MODEL, KNOWN_MODELS, chat, closeProvider, getMaxTokens,
  isRecognizedModel, resolveModel, resolveThinkEffort, setProvider, turnCost,
} from '../index.js'

const USAGE = `Usage: scripts/chat.js [options] [prompt]

Sends one prompt through chat() and prints the reply. The prompt may be a
positional argument, or piped in on stdin.

  -m, --model <id>      model to use (default: ${DEFAULT_MODEL})
  -p, --provider <name> anthropic, openai, openrouter, gateway, chrome,
                        moonshot, ollama. Inferred from the model's namespace
                        when omitted, so chrome/gemini-nano-v3 picks chrome —
                        but a local build shares its namespace with the
                        hosted model, so ollama has to be named.
  -s, --system <text>   system prompt
      --think           enable thinking
      --effort <level>  low, medium, high, xhigh, max, manual
      --max-tokens <n>  output cap (default: the model's registry value)
      --tools           offer the demo tools below and report what gets called
      --repl            read prompts a line at a time until EOF or Ctrl+C.
                        Each line is its own request — no history is carried
                        from one to the next — over one browser or connection
      --debug           per-turn timings, token usage and cost
      --list            print the models the registry knows, then exit
  -h, --help            show this message

  scripts/chat.js -m chrome/gemini-nano-v3 "What is the capital of France?"
  scripts/chat.js -m chrome/gemini-nano-v3 --tools "What is 21 plus 21?"
  scripts/chat.js -m chrome/gemini-nano-v3 --repl
  scripts/chat.js -p ollama -m google/gemma-4-26b-a4b-it-q4_k_m "Hello?"
  git diff | scripts/chat.js -s "Review this diff." -m anthropic/claude-opus-5
`

// Which adapter serves a namespace. Everything unlisted goes to OpenRouter,
// which is what resells the long tail of them.
const PROVIDER_FOR = {
  anthropic: 'anthropic',
  chrome: 'chrome',
  moonshotai: 'moonshot',
  openai: 'openai',
}

// Two tools with obviously checkable answers, so "did it really call one" is
// not a matter of reading the prose and hoping. `add` in particular is
// verifiable from the result alone.
const DEMO_TOOLS = [
  {
    name: 'add',
    description: 'Add two numbers and return the sum.',
    input_schema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
  {
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    input_schema: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  },
]

function runTool({ name, args, argsError }) {
  if (argsError) return `error: ${argsError}`
  if (name === 'add') return String(Number(args.a) + Number(args.b))
  if (name === 'get_weather') return `18C, clear in ${args.city}`
  return `error: no such tool ${name}`
}

const fail = (message) => { process.stderr.write(message); process.exit(2) }

function readStdin() {
  if (process.stdin.isTTY) return ''
  try { return readFileSync(0, 'utf8') } catch { return '' }
}

async function main(argv) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        debug: { type: 'boolean' },
        effort: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        list: { type: 'boolean' },
        'max-tokens': { type: 'string' },
        model: { type: 'string', short: 'm' },
        provider: { type: 'string', short: 'p' },
        repl: { type: 'boolean' },
        system: { type: 'string', short: 's' },
        think: { type: 'boolean' },
        tools: { type: 'boolean' },
      },
    })
  } catch (err) { return fail(`chat.js: ${err.message}\n\n${USAGE}`) }

  const { values, positionals } = parsed
  if (values.help) { process.stdout.write(USAGE); return }
  if (values.list) { process.stdout.write(KNOWN_MODELS.join('\n') + '\n'); return }

  const model = resolveModel(values.model ?? DEFAULT_MODEL)
  // A typo here otherwise reaches the wire as an unknown id and comes back as
  // a provider error, which reads as the model's fault rather than the
  // spelling's.
  if (!isRecognizedModel(model)) fail(`chat.js: unknown model ${model}. --list shows what the registry knows.\n`)

  // --repl reads its prompts from stdin itself, one request per line, so
  // there is nothing to drain here and nothing to insist on.
  const userContent = positionals.join(' ').trim() || (values.repl ? '' : readStdin().trim())
  if (!userContent && !values.repl) fail(`chat.js: no prompt given\n\n${USAGE}`)

  // What the layer provides for exactly this: a model that cannot reason
  // refuses --think here, with one wording shared by every caller. Skipping
  // it let the request reach buildRequestBody, which throws from inside
  // issueTurn and escapes chat() as a stack trace rather than a message —
  // and on a chrome row, which has no thinking mode at all, that is the
  // normal path rather than an edge case.
  let think
  try { think = resolveThinkEffort(model, values.think, values.effort) } catch (err) { return fail(`chat.js: ${err.message}\n`) }

  const provider = values.provider ?? PROVIDER_FOR[model.split('/')[0]] ?? 'openrouter'
  // A session is not an idle browser: ten seconds of thinking about what to
  // type would put a cold start in front of the next line. A minute, rather
  // than never, so a session left open still lets go. The caller's own
  // setting still wins.
  if (values.repl) process.env.CHROME_IDLE_MS ??= '60000'
  try { setProvider(provider) } catch (err) { return fail(`chat.js: ${err.message}\n`) }

  // Same reason --think is resolved above rather than left to the wire: a
  // provider that refuses the request — no browser, no weights, a row gated
  // behind an opt-in — throws from inside chat(), and without this the script
  // exits on a stack trace pointing into chrome/model.js instead of saying
  // what the caller has to change.
  try {
    await run({ model, provider, userContent, values, think })
  } catch (err) { return fail(`chat.js: ${err.message}\n`) }
}

async function run({ model, provider, userContent, values, think }) {
  try {
    if (values.repl) await repl({ model, provider, userContent, values, think })
    else await turn({ model, provider, userContent, values, think })
  } finally {
    // Always. The chrome provider holds a browser open, and without this the
    // process never exits — which is the whole reason closeProvider exists.
    await closeProvider()
  }
}

// One request. Nothing is carried between calls: the model, the system prompt
// and the flags are the same each time, the prompt is not, and the provider
// underneath keeps whatever it opened.
async function turn({ model, provider, userContent, values, think }) {
  const started = Date.now()
  const calls = []
  const tools = values.tools ? DEMO_TOOLS : undefined
  const { text, error, usage } = await chat({
    model,
    maxTokens: values['max-tokens'] ? Number(values['max-tokens']) : getMaxTokens(model),
    systemPrompt: values.system ?? 'You are a helpful assistant.',
    userContent,
    tools,
    // chat() requires the pair, so the handler is only wired up alongside.
    handleToolCall: tools
      ? (call) => { const result = runTool(call); calls.push({ ...call, result }); return result }
      : undefined,
    // The resolved pair, not the raw flags: the cache key and the request
    // then agree on what was actually asked for.
    think: think.useThink,
    effort: think.useEffort,
    debug: Boolean(values.debug),
    label: 'chat.js',
  })
  // Before the answer, because whether a tool ran at all is the question
  // --tools exists to settle, and an empty list is a real result.
  if (values.tools) reportTools(calls)
  // Thrown rather than failed: fail() exits the process on the spot, which
  // skips the cleanup in run() and leaves the browser it was there to close
  // running. main() catches this and prints it with the same wording.
  if (error) throw new Error(error)
  process.stdout.write(text.endsWith('\n') ? text : text + '\n')
  if (values.debug) report({ model, provider, usage, elapsed: Date.now() - started })
}

// A line at a time, each line its own request. The point is the provider
// underneath: one browser, or one connection, answering all of them.
async function repl(options) {
  // Prompts and echo to stderr, answers to stdout, so a piped run reads as
  // the answers alone.
  const rl = createInterface({ input: process.stdin, output: process.stderr, prompt: '> ' })
  // Ctrl+C ends the session rather than the process, so the provider is
  // closed on the way out rather than left to an exit hook.
  rl.on('SIGINT', () => rl.close())
  // Piped input reaches EOF while the first turn is still running, so the
  // interface is closed by the time one returns — and prompting a closed one
  // throws rather than doing nothing, which ended the session at the line
  // after the first. The lines already read still arrive.
  const prompt = () => { if (!rl.closed) rl.prompt() }
  // Taken before the first turn is awaited, for the same reason: asking a
  // closed interface for its iterator never resolves, and a for-await asks
  // for one only when it reaches the loop. Lines read before EOF still come
  // through this one.
  const lines = rl[Symbol.asyncIterator]()
  if (options.userContent) await answer(options, options.userContent)
  prompt()
  for (let line = await lines.next(); !line.done; line = await lines.next()) {
    if (line.value.trim()) await answer(options, line.value.trim())
    prompt()
  }
  rl.close()
}

// A failed turn ends the turn, not the session: a refused request, a model
// that would not answer, or a provider error is the next thing to try
// something else about.
async function answer(options, userContent) {
  try {
    await turn({ ...options, userContent })
  } catch (err) {
    process.stderr.write(`chat.js: ${err.message}\n`)
  }
}

function reportTools(calls) {
  if (calls.length === 0) {
    process.stderr.write(styleText('dim', 'no tool was called') + '\n')
    return
  }
  for (const { name, args, argsError, result } of calls) {
    const asked = argsError ?? JSON.stringify(args)
    process.stderr.write(styleText('dim', `tool ${name}(${asked}) -> ${result}`) + '\n')
  }
}

function report({ model, provider, usage, elapsed }) {
  const cost = usage.cost > 0 ? usage.cost : (turnCost(model, usage) ?? 0)
  const line = [
    `${provider}:${model}`,
    `${(elapsed / 1000).toFixed(1)}s`,
    `in=${usage.input}`,
    `out=${usage.output}`,
    usage.cacheRead > 0 ? `cacheRead=${usage.cacheRead}` : null,
    // On-device rows price at zero, and printing $0.0000 for them is the
    // point rather than a rounding artefact.
    `$${cost.toFixed(4)}`,
  ].filter(Boolean).join('  ')
  process.stderr.write(styleText('dim', line) + '\n')
}

await main(process.argv.slice(2))
