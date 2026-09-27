// Hand-written against git.js; a change to either belongs with the other.

export interface GitCheckout {
  // HEAD's commit sha.
  commit: string
  // Where the directory sits in its checkout, `/`-separated; empty at the
  // root.
  directory: string
  // `owner/name`, when the origin remote is a GitHub one. Never the
  // remote's URL, which can name a private host or carry a token.
  github?: string
}

// The checkout at or above `dir`, found by its closest `.git` (a
// directory, or a `gitdir:` file) and read without running git. Best
// effort: null where there is no checkout or its HEAD cannot be read.
export function findGitCheckout(dir: string): Promise<GitCheckout | null>
