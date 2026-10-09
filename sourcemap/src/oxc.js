// oxc-parser, an optional peer dependency, as each platform gets it, the way
// @exodus/bytes splits a module: Node's by default, and package.json's
// `browser` field points a browser bundle at oxc.browser.js.
export * from './oxc.node.js'
