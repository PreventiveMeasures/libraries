import { compareVersions as comparePypiVersions, isVersion as isPypiVersion, lowerBoundsBelow as pypiBoundsBelow, releaseOf as pypiRelease, readRange as readPypiRange } from '../pypi/version.js'
import { compareVersions as compareGemVersions, exclusionsOf, lowerBoundsBelow as gemBoundsBelow, releaseOf as gemRelease, isVersion as isGemVersion, meetsLowerBounds } from '../rubygems/version.js'
import { compareVersions as compareSemver, isExactVersion } from '../semver.js'
import { inRange, isOpenAbove, overlap } from './common.js'

// Of two releases, the number they first differ in, the major's or the
// minor's; -1 where neither does, as one line.
function lineAt(a, b) {
  for (const at of [0, 1]) if ((a[at] ?? 0n) !== (b[at] ?? 0n)) return at
  return -1
}

// A range with no end of its own, ended below the versions an advisory
// names as patched, a range per release line: below the lowest, then from
// where each one's line ends to below the next. A line is a major, or a
// minor where the next patched version is of the same major; the highest
// of a line's patched versions ends it, and a line none ends stays in. A
// line the range begins below keeps what the range leaves out (a gem's
// `!=`). Any other range, or a list it can't read all of, is as given.
//
// So Next.js's GHSA-ggv3-7p47-pfv8, `>=9.5.0` patched in `16.1.7, 15.5.13`,
// is `>=9.5.0, < 15.5.13` and `>= 16.0.0-0, < 16.1.7`, as GitHub reviewed it.
function endBelow({ isVersion, compare, release, lowest, opensBelow, above, kept = () => [] }) {
  return (range, patched) => {
    const versions = typeof patched === 'string' && patched.length <= 1024 ? patched.split(',').map((part) => part.trim()) : []
    if (versions.length === 0 || !versions.every(isVersion)) return [range]
    const given = range.trim()
    const sorted = versions.toSorted(compare)
    const releases = sorted.length > 1 ? sorted.map(release) : []
    if ((given !== '' && !opensBelow(given, sorted.at(-1))) || releases.includes(undefined)) return [range]
    const ranges = []
    let from
    for (const [i, version] of sorted.entries()) {
      const at = i + 1 < sorted.length ? lineAt(releases[i], releases[i + 1]) : 0
      if (at === -1) continue
      const below = `< ${version}`
      if (from !== undefined && given === '') ranges.push(`>= ${from}, ${below}`)
      else if (given === '') ranges.push(below)
      else if (from !== undefined && above(given, from)) ranges.push([`>= ${from}`, ...kept(given), below].join(', '))
      else if (opensBelow(given, version)) ranges.push(`${given}, ${below}`)
      if (i + 1 < sorted.length) from = lowest([...releases[i].slice(0, at), (releases[i][at] ?? 0n) + 1n])
    }
    return ranges
  }
}

// GitHub's `>= 1.0.0, < 1.2.6` is npm's without the commas.
const npm = (range) => range.replaceAll(',', ' ')

// A line from its lowest prerelease, `-0`.
export const boundSemverRange = endBelow({
  isVersion: isExactVersion,
  compare: compareSemver,
  release: (version) => /^\d+\.\d+\.\d+/u.exec(version)[0].split('.').map(BigInt),
  lowest: (release) => `${[...release, 0n, 0n].slice(0, 3).join('.')}-0`,
  opensBelow: (range, version) => isOpenAbove(npm(range)) && overlap(npm(range), `< ${version}`),
  above: (range, version) => inRange(version, npm(range)),
})

// From `.A`, below any letters a prerelease has: Ruby orders them by byte.
export const boundGemRange = endBelow({
  isVersion: isGemVersion,
  compare: compareGemVersions,
  release: gemRelease,
  lowest: (release) => `${release.join('.')}.A`,
  opensBelow: gemBoundsBelow,
  above: meetsLowerBounds,
  kept: exclusionsOf,
})

// From `.dev0`, below its pre-releases.
export const boundPypiRange = endBelow({
  isVersion: isPypiVersion,
  compare: comparePypiVersions,
  release: pypiRelease,
  lowest: (release) => `${release.join('.')}.dev0`,
  opensBelow: pypiBoundsBelow,
  above: (range, version) => readPypiRange(range)(version),
})
