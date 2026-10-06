# Weak dependency edges

`@preventive/upstream/weak-edges.js` inventories known configuration, discovery,
and version-check loads. They are real observed loads, but do not establish why
the importing package requires the loaded package. For example, a host project
chooses a Babel preset; Babel's config loader loading it does not make that
preset a dependency of Babel itself.

Consumers should omit these edges from cycle detection and from the paths and
edges displayed by default when investigating **why a module is included**.
Apply the same filter to forward traversal, reverse traversal, path selection,
and rendering. Hiding an edge only after computing paths can still produce a
misleading explanation or include unrelated modules.

Retain the original load records for execution, bundling, provenance, and an
explicit raw-load view. A weak edge alone does not authorize pruning its target
file or package. This module classifies edges; it does not change consumers or
runtime resolution automatically.

## Inventory

Paths below are relative to the owning package. `*` in this table summarizes the
exact selectors exported in `weakEdges`; it is not a general glob API.

| Importing package / path | Loaded package / path | Why weak |
| --- | --- | --- |
| `react-native` / `scripts/codegen/generate-artifacts-executor.js` | Any package or own source / basename `package.json` or `react-native.config.js` | Codegen metadata and config discovery |
| `@react-native-community/cli-tools` / `build/releaseChecker/index.js` | `react-native` / `package.json` | Installed-version check |
| `react-native` / `react-native.config.js` | `@react-native-community/cli-platform-android` or `@react-native-community/cli-platform-ios` / `build/index.js` | Platform CLIs supplied by the host project |
| `@babel/core` / anything under `lib/config/` | Any package or own source / basename `babel.config.js` | Project config discovery |
| `@babel/core` / anything under `lib/config/` | `@babel/preset-typescript` / any file | Configured TypeScript preset |
| `@babel/core` / `lib/config/files/module-types.js` or `lib/config/files/plugins.js` | `@react-native/babel-preset` / `index.js` or `src/index.js` | Configured React Native preset |
| Same two Babel loaders | `react-native-reanimated` or `@<scope>/react-native-reanimated` / `plugin/index.js` | Configured Reanimated plugin |
| Same two Babel loaders | `@babel/plugin-transform-*` / `lib/index.js` | Configured transform plugin |
| `cosmiconfig` / `dist/loaders.js` | Any package or own source / `*.config.js` | Config discovery, including dependency configs such as React Native's own config |
| `import-fresh` / any file | **Own source only** / `*.config.js` | Host-project config load |

The inventory reflects the observed pairs collected in
[Triage's cycle exclusions](https://github.com/PreventiveMeasures/triage/blob/34b5f4e/ui/view/graph/cycle-imports.js).
The TypeScript preset rule covers the whole Babel config subtree, not just the
two loader files. The Cosmiconfig rule covers dependency configs too; the
`import-fresh` rule still requires affirmative own-source ownership.

## Usage

```js
import { getWeakEdge, weakEdges } from '@preventive/upstream/weak-edges.js'

const rule = getWeakEdge(
  { package: '@babel/core', path: 'lib/config/files/plugins.js' },
  { package: '@babel/preset-typescript', path: 'lib/index.js' },
)
// rule.id === 'babel-typescript-preset'; rule.reason explains the classification.

getWeakEdge(
  { package: 'import-fresh', path: 'index.js' },
  { path: 'tools/metro.config.js', ownSource: true },
)
// An absent or false ownSource value does not match this rule.

const explanatoryEdges = recordedEdges.filter(edge => !getWeakEdge(edge.from, edge.to))
// Use explanatoryEdges for both cycle analysis and the "why included" graph.
// weakEdges exposes the complete catalog, including IDs, reasons, and selectors.
```

Use authoritative package ownership and package-relative file paths. For an
original path such as
`node_modules/outer/node_modules/@babel/core/lib/config/files/plugins.js`, pass
package `@babel/core` and path `lib/config/files/plugins.js`. The same applies to
pnpm installations. Resolve a package's nested dependencies to their own owners;
do not pass their paths as files of the containing package. Display names and
shortened graph labels are not package identities. An own-source directory named
like a package must not be classified as that installed package.
Package-specific target selectors reject `ownSource: true`; package-agnostic
discovery rules still allow own-source targets.

Unknown edges remain eligible. The inventory does not classify every computed
import, every config-file import, all Babel presets, or all CLI dependencies as
weak. Syntax alone is insufficient: even a literal specifier can represent a
host-selected config load. The selectors are path-based and currently have no
version constraints; they describe the listed layouts, not every possible
version of each package.

Filter individual file edges **before** grouping files into packages. A weak
load must not hide a separate ordinary import between the same packages. If an
ordinary path from an entry point still reaches a package, keep that explanation
and any cycle formed by ordinary edges. If filtering removes all explanations,
report that no strong recorded path is available rather than fabricating one.
