#!/usr/bin/env node
// pod-install [--project-directory=DIR]
// What `pod install` does for a React Native app, without CocoaPods or Ruby: from the Podfile.lock, the JSON
// podspecs committed beside it (Podspecs/<name>.podspec.json, each held to the lockfile's checksum) and
// pod.config.json (src/config.js), it downloads each pod's archive, held to the sha256 its podspec gives, and
// generates Pods/ -- the Pods project, every target's support files, the header links and Manifest.lock -- as
// CocoaPods 1.16 does, for the app's own project to build with as it is.

import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { createClient } from '@preventive/upstream/github.js'

import { install } from '../src/install.js'

const fail = (message) => {
  process.stderr.write(`pod-install: ${message}\n`)
  process.exit(1)
}

let args
try {
  args = parseArgs({ options: { 'project-directory': { type: 'string' }, help: { type: 'boolean', short: 'h' } } }).values
} catch (error) {
  fail(error.message)
}
if (args.help) {
  process.stdout.write('pod-install [--project-directory=DIR]\n')
  process.exit(0)
}

try {
  const { pods, targets, downloaded, written } = await install(resolve(args['project-directory'] ?? '.'), createClient({ token: process.env.GITHUB_TOKEN ?? null }))
  process.stdout.write(`pod-install: ${pods.length} pods for ${targets.join(', ')}; ${downloaded.length} downloaded, ${written} files written\n`)
} catch (error) {
  if (error?.name !== 'PodError' && error?.name !== 'DeptreeError' && error?.name !== 'LockfileError') throw error
  fail(error.message)
}
