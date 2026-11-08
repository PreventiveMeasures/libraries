// A constraint as parseConstraints makes it; read it with allows.
export type ComposerConstraint =
  | { readonly all: true }
  | { readonly operator: string, readonly version: string }
  | { readonly multi: readonly ComposerConstraint[], readonly conjunctive: boolean }

// The normal form (`v1.2` is `1.2.0.0`), or undefined where Composer throws.
export function normalize(version: string): string | undefined

// What Composer makes of a constraint (`>=1.0,<1.2|^2.0`), or undefined
// where it throws.
export function parseConstraints(text: string): ComposerConstraint | undefined

// Whether a normalized version is in what the constraint allows.
export function allows(constraint: ComposerConstraint, version: string): boolean
