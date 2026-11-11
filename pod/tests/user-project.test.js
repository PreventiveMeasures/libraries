import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { readUserProject } from '../src/generate/user-project.js'

// The dynamic fixture's project, as CocoaPods integrated it, and as it would have with its Debug configuration
// under another name: the configuration's, and its xcconfigs' after it.
const TEXT = readFileSync(new URL('fixtures/dynamic/project/App.xcodeproj/project.pbxproj', import.meta.url), 'utf8')
const renamed = (name, file, text = TEXT) => text.replaceAll('name = Debug;', `name = ${JSON.stringify(name)};`).replaceAll('.debug.xcconfig', `.${file}.xcconfig`)
const targetsOf = (text) => readUserProject(text, 'App.xcodeproj').targets.map((target) => [target.name, target.label, target.configurations])

describe('readUserProject', () => {
  it('reads the Pods target of each of the app\'s targets off the xcconfigs its configurations are based on', () => {
    assert.deepEqual(targetsOf(TEXT), [['App', 'Pods-defaults-App', ['Release', 'Debug']], ['Ext', 'Pods-defaults-Ext', ['Release', 'Debug']]])
  })

  it('takes a configuration\'s name out of the xcconfig\'s as CocoaPods puts it in, whatever is in the name', () => {
    // `pod install` 1.16.2 writes Pods-defaults-App.debug.qa.xcconfig for a configuration Debug.QA.
    assert.deepEqual(targetsOf(renamed('Debug.QA', 'debug.qa')), [['App', 'Pods-defaults-App', ['Release', 'Debug.QA']], ['Ext', 'Pods-defaults-Ext', ['Release', 'Debug.QA']]])
    assert.deepEqual(targetsOf(renamed('QA/Debug 1.0', 'qa-debug 1.0')).map(([, label]) => label), ['Pods-defaults-App', 'Pods-defaults-Ext'])
    // And a period in the target's own name stays in its label.
    const dotted = renamed('Debug.QA', 'debug.qa').replaceAll('Pods-defaults-App', 'Pods-My.App')
    assert.deepEqual(targetsOf(dotted).map(([, label]) => label), ['Pods-My.App', 'Pods-defaults-Ext'])
  })

  it('takes an xcconfig of another configuration\'s name too, as of a configuration copied in Xcode since', () => {
    assert.deepEqual(targetsOf(renamed('Staging', 'debug')), [['App', 'Pods-defaults-App', ['Release', 'Staging']], ['Ext', 'Pods-defaults-Ext', ['Release', 'Staging']]])
  })

  it('refuses a target whose configurations are of more than one Pods target, or some of none', () => {
    const mixed = TEXT.replaceAll('Pods-defaults-App.release.xcconfig', 'Pods-defaults-Other.release.xcconfig')
    assert.throws(() => readUserProject(mixed, 'App.xcodeproj'), /targets\["App"\]: its configurations are based on the xcconfigs of more than one Pods target, or some on none/u)
  })
})
