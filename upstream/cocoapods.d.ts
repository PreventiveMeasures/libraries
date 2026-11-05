// The name is asserted to be a root's as Podfile.lock writes it, printable
// ASCII but for spaces, parentheses, slashes and backslashes, with no `.`
// first; the version one of Pod::Version's; and the checksum 40 lowercase
// hex digits, before any request or cache path. The cache is setCacheDir's
// (npm.js).

export { HttpError } from './npm.js'

// A version's podspec from trunk, the JSON CocoaPods reads, whole, in
// memory, as the CDN serves it under Specs/<a>/<b>/<c>/<name>/<version>/,
// the first three hex digits of the md5 of the name: the files of
// CocoaPods/Specs, so a pod from https://github.com/CocoaPods/Specs.git
// too. Trunk says nothing of what a podspec hashes to, so `checksum` is
// required: its sha1, as Podfile.lock records it in SPEC CHECKSUMS. The
// bytes are checked against it, whether they were downloaded (before they
// are cached) or read from a cache. The CDN's redirect to jsDelivr is
// followed, as the bytes are checked whoever answers.
//
// A podspec is not fixed once trunk has it: `pod trunk deprecate` adds a
// field to the latest version's. So one is cached by its checksum as well
// as its version, and a lockfile written before such a change has a
// checksum no download matches any longer, which throws.
//
// CocoaPods' own spec repos are read first, and never written: that path
// in each directory under $CP_REPOS_DIR, else $CP_HOME_DIR/repos, else
// `~/.cocoapods/repos`. A file there that does not match is passed over.
// One in setCacheDir's cache that does not match throws. A cached podspec
// that matches is answered with no request at all.
//
// What the pod is built from is not trunk's, and is not fetched here: a
// commit of a GitHub repo, as a podspec's `source` or CHECKOUT OPTIONS
// may name, is github.js's getRepoTarball's; an archive by :http is
// getPodArchive's.
export function getPodspec(name: string, version: string, checksum: string): Promise<Uint8Array>

// An archive a podspec's `source` names by :http, from GitHub alone, whole,
// in memory: `url` is https://github.com/<owner>/<repo>/ and a path under
// it, such as GitHub's archive of a tag, `archive/refs/tags/<tag>.tar.gz`,
// or a release's asset, `releases/download/<tag>/<file>`, as written, with
// no query, fragment, credentials or port, and each segment of the path
// letters, digits, `_`, `.`, `~`, `@`, `-` or a %-escape in capitals. The
// hash is the podspec's :sha256, in lowercase hex, as cocoapods-downloader
// checks it; a sha1, which two archives made to collide share, is not
// taken. GitHub answers with a
// redirect, to codeload.github.com or to where it keeps a release's files,
// which is followed, as the bytes are held to the hash whoever answers,
// downloaded (before they are cached) or read from setCacheDir's cache. They
// are cached by the hash alone; one in the cache that does not match throws.
// Each argument is asserted before any request.
export function getPodArchive(url: string, sha256: string): Promise<Uint8Array>
