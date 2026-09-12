#!/usr/bin/env node
// One prompt, one answer, against any provider the layer knows — the small
// harness that makes `chrome` testable by hand, and every other provider
// comparable against it in the same breath.
// Not part of the published package; run it as `scripts/chat.js "prompt"`.

import { readFileSync } from 'node:fs'
import process from 'node:process'
import { parseArgs, styleText } from 'node:util'
import {
  DEFAULT_MODEL, KNOWN_MODELS, calculateCost, chat, closeProvider, getMaxTokens,
  isRecognizedModel, resolveModel, setProvider,
} from '../index.js'

const USAGE = `Usage: scripts/chat.js [options] <prompt>

Sends one prompt through chat() and prints the reply. The prompt may be a
positional argument, or piped in on stdin.

  -m, --model <id>      model to use (default: ${DEFAULT_MODEL})
  -p, --provider <name> anthropic, openai, openrouter, gateway, chrome,
                        moonshot. Inferred from the model's namespace when
                        omitted, so chrome/nano_v3 picks chrome.
  -s, --system <text>   system prompt
      --think           enable thinking
      --effort <level>  low, medium, high, xhigh, max, manual
      --max-tokens <n>  output cap (default: the model's registry value)
      --debug           per-turn timings, token usage and cost
      --list            print the models the registry knows, then exit
  -h, --help            show this message

  scripts/chat.js -m chrome/nano_v3 "What is the capital of France?"
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
        system: { type: 'string', short: 's' },
        think: { type: 'boolean' },
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

  const userContent = positionals.join(' ').trim() || readStdin().trim()
  if (!userContent) fail(`chat.js: no prompt given\n\n${USAGE}`)

  const provider = values.provider ?? PROVIDER_FOR[model.split('/')[0]] ?? 'openrouter'
  try { setProvider(provider) } catch (err) { return fail(`chat.js: ${err.message}\n`) }

  await run({ model, provider, userContent, values })
}

async function run({ model, provider, userContent, values }) {
  const started = Date.now()
  try {
    const { text, error, usage } = await chat({
      model,
      maxTokens: values['max-tokens'] ? Number(values['max-tokens']) : getMaxTokens(model),
      systemPrompt: values.system ?? 'You are a helpful assistant.',
      userContent,
      think: Boolean(values.think),
      effort: values.effort,
      debug: Boolean(values.debug),
      label: 'chat.js',
    })
    if (error) fail(`chat.js: ${error}\n`)
    process.stdout.write(text.endsWith('\n') ? text : text + '\n')
    if (values.debug) report({ model, provider, usage, elapsed: Date.now() - started })
  } finally {
    // Always. The chrome provider holds a browser open, and without this the
    // process never exits — which is the whole reason closeProvider exists.
    await closeProvider()
  }
}

function report({ model, provider, usage, elapsed }) {
  const cost = usage.cost > 0 ? usage.cost : (calculateCost(model, usage) ?? 0)
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
