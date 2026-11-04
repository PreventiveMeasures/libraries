import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { entriesOf } from '../serve/serve-cache.js'
import { writeTree } from './fixtures.js'

// React Native's templates' (0.88's), of a bundle root of their own.
const swift = (root) => `class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {\n  override func bundleURL() -> URL? {\n#if DEBUG\n    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "${root}")\n#else\n    Bundle.main.url(forResource: "main", withExtension: "jsbundle")\n#endif\n  }\n}\n`
const objc = (root) => `- (NSURL *)bundleURL\n{\n#if DEBUG\n  return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"${root}"];\n#endif\n}\n`
const kotlin = 'class MainApplication : Application(), ReactApplication {\n  override val reactHost: ReactHost by lazy {\n    getDefaultReactHost(context = applicationContext, packageList = PackageList(this).packages)\n  }\n}\n'
const java = (root) => `public class MainApplication extends Application implements ReactApplication {\n  @Override\n  protected String getJSMainModuleName() {\n    return "${root}";\n  }\n}\n`
// Of a project of `tree`: the entries of its bundles for `platform`, in order.
const bundled = (tree, platform) => {
  const { root, cleanup } = writeTree(tree)
  try {
    return entriesOf(root, platform).toSorted()
  } finally {
    cleanup()
  }
}

describe('entriesOf', () => {
  it("has the bundle the native project names, of a file of the project's", () => {
    assert.deepEqual(bundled({ 'index.js': '', 'ios/App/AppDelegate.swift': swift('index') }, 'ios'), ['./index'])
    assert.deepEqual(bundled({ 'main.ios.tsx': '', 'ios/App/AppDelegate.mm': objc('main') }, 'ios'), ['./main'])
    assert.deepEqual(bundled({ 'src/entry.ts': '', 'android/app/src/main/java/com/example/app/MainApplication.java': java('src/entry') }, 'android'), ['./src/entry'])
    // Of none named, React Native's DefaultReactHost's: index.
    assert.deepEqual(bundled({ 'index.js': '', 'android/app/src/main/java/com/example/app/MainApplication.kt': kotlin }, 'android'), ['./index'])
  })

  it('has its index, of no native project, or one that names none', () => {
    assert.deepEqual(bundled({ 'index.ts': '' }, 'ios'), ['./index'])
    assert.deepEqual(bundled({ 'index.js': '', 'ios/App/AppDelegate.swift': 'let url = provider.jsBundleURL(forBundleRoot: root)\n' }, 'ios'), ['./index'])
    assert.deepEqual(bundled({ 'App.tsx': '' }, 'ios'), [])
  })

  it("has none of several, which it names, nor of one of no file, nor of Pods' or another platform's", () => {
    assert.deepEqual(bundled({ 'index.js': '', 'share.js': '', 'ios/App/AppDelegate.swift': swift('index'), 'ios/Share/AppDelegate.swift': swift('share') }, 'ios'), ['./index', './share'])
    assert.deepEqual(bundled({ 'index.js': '', 'ios/App/AppDelegate.swift': swift('.expo/.virtual-metro-entry') }, 'ios'), [])
    assert.deepEqual(bundled({ 'index.js': '', 'pod.js': '', 'ios/App/AppDelegate.swift': swift('index'), 'ios/Pods/Pod/AppDelegate.swift': swift('pod') }, 'ios'), ['./index'])
    assert.deepEqual(bundled({ 'index.js': '', 'other.js': '', 'ios/App/AppDelegate.swift': swift('other') }, 'android'), ['./index'])
  })
})
