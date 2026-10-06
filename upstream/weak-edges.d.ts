/** A resolved file, identified by its owning package rather than a display path. */
export interface WeakEdgeFile {
  /** Exact npm package name, including scope. May be absent for own source. */
  package?: string
  /** Normalized /-separated path relative to the owning package or own-source root. */
  path: string
  /** Authoritative project ownership, not inferred from a package name or path. */
  ownSource?: boolean
}

export interface WeakEdgeSelector {
  /** Absent means any package or own source. Regular expressions match package names. */
  readonly package?: string | RegExp
  readonly path: RegExp
}

export interface WeakEdgeRule {
  readonly id: string
  readonly reason: string
  readonly from: WeakEdgeSelector
  readonly to: WeakEdgeSelector
  readonly ownSourceOnly?: boolean
}

/** Curated weak loads: omit these file edges from cycles and default inclusion explanations. */
export const weakEdges: readonly WeakEdgeRule[]

/**
 * Returns the matching inventory rule, or undefined for an unrecognized edge.
 * Own-source importers never match. import-fresh requires to.ownSource === true.
 * Own-source targets only match selectors without a package constraint.
 * Resolve nested installations to their actual owning package before calling;
 * absolute, non-normalized, or nested node_modules paths do not match.
 * Does not remove files, alter raw load records, or change runtime resolution.
 */
export function getWeakEdge(from: WeakEdgeFile, to: WeakEdgeFile): WeakEdgeRule | undefined
