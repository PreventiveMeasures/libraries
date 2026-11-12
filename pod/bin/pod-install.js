#!/usr/bin/env node
// pod-install [--project-directory=DIR]
// What `pod install` does for a React Native app, without CocoaPods or Ruby: from the Podfile.lock, each pod's
// podspec and pod.config.json (src/config.js), it downloads each pod's archive, from GitHub or Maven Central's
// com/facebook/ and held to the sha256 its podspec gives, and generates Pods/ -- the Pods project, every target's support files, the header links and
// Manifest.lock -- as CocoaPods 1.16 does, for the app's own project to build with as it is.
//
// A podspec is taken as <name>.podspec.json, the JSON CocoaPods keeps of one, or as <name>.podspec where that
// is in the form read without Ruby (src/podspec/read.js): from Podspecs/ beside the lockfile, else from where
// the lockfile has the pod. Either way it is held to the lockfile's checksum, the sha1 of that JSON.

import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

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
  const { pods, targets, downloaded, written } = await install(resolve(args['project-directory'] ?? '.'))
  process.stdout.write(`pod-install: ${pods.length} pods for ${targets.join(', ')}; ${downloaded.length} downloaded, ${written} files written\n`)
} catch (error) {
  if (error?.name !== 'PodError' && error?.name !== 'LockfileError') throw error
  fail(error.message)
}
