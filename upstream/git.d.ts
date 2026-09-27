// Hand-written against git.js; a change to either belongs with the other.

// The shape getRepo (package.js) answers in, and HEAD's commit. Each
// field best-effort: left out where it cannot be read.
export interface GitCheckout {
  // `owner/name`, when the origin remote is a GitHub one. Never the
  // remote's URL, which can name a private host or carry a token.
  github?: string
  // Where the directory sits in its checkout, `/`-separated; absent at
  // the root.
  directory?: string
  // `https://github.com/<github>`, whenever there is a `github`.
  url?: string
  // HEAD's commit sha.
  commit?: string
}

// The checkout at or above `dir`, found by its closest `.git` (a
// directory, or a `gitdir:` file) and read without running git. Empty
// where there is no checkout.
export function findGitCheckout(dir: string): Promise<GitCheckout>
