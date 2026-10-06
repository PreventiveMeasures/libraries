// Package-relative coordinates keep this inventory independent of installation
// roots, pnpm layouts, display-prefix stripping, and graph package grouping.
const babelConfig = { package: '@babel/core', path: /^lib\/config\//u }
const babelPlugins = { package: '@babel/core', path: /^lib\/config\/files\/(?:module-types|plugins)\.js$/u }

export const weakEdges = Object.freeze([
  {
    id: 'react-native-codegen-discovery',
    reason: 'Codegen discovers package metadata and React Native configuration.',
    from: { package: 'react-native', path: /^scripts\/codegen\/generate-artifacts-executor\.js$/u },
    to: { path: /(?:^|\/)(?:package\.json|react-native\.config\.js)$/u },
  },
  {
    id: 'react-native-release-version',
    reason: 'The CLI release checker reads the installed React Native version.',
    from: { package: '@react-native-community/cli-tools', path: /^build\/releaseChecker\/index\.js$/u },
    to: { package: 'react-native', path: /^package\.json$/u },
  },
  {
    id: 'react-native-platform-config',
    reason: 'React Native configuration loads platform CLIs supplied by the host project.',
    from: { package: 'react-native', path: /^react-native\.config\.js$/u },
    to: { package: /^@react-native-community\/cli-platform-(?:android|ios)$/u, path: /^build\/index\.js$/u },
  },
  {
    id: 'babel-project-config',
    reason: 'Babel discovers project configuration.',
    from: babelConfig,
    to: { path: /(?:^|\/)babel\.config\.js$/u },
  },
  {
    id: 'babel-typescript-preset',
    reason: 'Babel configuration loads the TypeScript preset.',
    from: babelConfig,
    to: { package: '@babel/preset-typescript', path: /./u },
  },
  {
    id: 'babel-react-native-preset',
    reason: 'Babel config loaders load the configured React Native preset.',
    from: babelPlugins,
    to: { package: '@react-native/babel-preset', path: /^(?:src\/)?index\.js$/u },
  },
  {
    id: 'babel-reanimated-plugin',
    reason: 'Babel config loaders load the configured Reanimated plugin, including scoped copies.',
    from: babelPlugins,
    to: { package: /^(?:@[^/]+\/)?react-native-reanimated$/u, path: /^plugin\/index\.js$/u },
  },
  {
    id: 'babel-transform-plugin',
    reason: 'Babel config loaders load configured transform plugins.',
    from: babelPlugins,
    to: { package: /^@babel\/plugin-transform-[^/]+$/u, path: /^lib\/index\.js$/u },
  },
  {
    id: 'cosmiconfig-config',
    reason: 'Cosmiconfig loads discovered configuration, including dependency configuration.',
    from: { package: 'cosmiconfig', path: /^dist\/loaders\.js$/u },
    to: { path: /\.config\.js$/u },
  },
  {
    id: 'import-fresh-own-config',
    reason: 'import-fresh loads host-project configuration.',
    from: { package: 'import-fresh', path: /./u },
    to: { path: /\.config\.js$/u },
    ownSourceOnly: true,
  },
].map(rule => Object.freeze({ ...rule, from: Object.freeze(rule.from), to: Object.freeze(rule.to) })))

// Do not guess ownership from a partial or shortened path. A nested dependency
// must be passed as its own package, not as node_modules/... inside its parent.
function normalizedPath(path) {
  return typeof path === 'string' && !path.includes('\\') && !path.includes(':')
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part !== 'node_modules')
}

function matches(selector, file) {
  const pkg = selector.package
  return (pkg === undefined || (typeof pkg === 'string' ? pkg === file.package : pkg.test(file.package ?? '')))
    && selector.path.test(file.path)
}

export function getWeakEdge(from, to) {
  if (from?.ownSource === true || !normalizedPath(from?.path) || !normalizedPath(to?.path)) return undefined
  return weakEdges.find(rule => (!rule.ownSourceOnly || to.ownSource === true) && matches(rule.from, from) && matches(rule.to, to))
}
