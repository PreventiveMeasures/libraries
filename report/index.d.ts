// Type declarations for `index.js`. Hand-written so the JS source stays
// untouched, and deliberately partial: only the surface a TypeScript caller
// imports today (triage's server-managed/ and common/managed/) is declared
// here. An export missing from this file is one no TS caller has needed
// yet, not one that is gone — declare it here when one does.

// Recognise, flatten, and give every finding an id — the whole read path in
// one call. `findings` are the parser's own objects; null when nothing
// recognises the text.
export function loadFindings(content: string): Promise<{ format: string, data: unknown, findings: unknown[] } | null>
export function readReport(content: string): { data: any, format: string | null, reason: string | null }
export function reportRepoGithub(data: any): string | null
export function inheritReportMeta(finding: Record<string, unknown>, data: Record<string, unknown>): void
export function isAppFinding(finding: unknown, source?: unknown): boolean
export function stampSecurityGroups(groups: Record<string, unknown>[][], options?: { linkedIds?: (id: string) => Iterable<string> }): boolean
export function reportEntries(data: unknown): unknown[] | null
export function repoDirectory(repo: any): string
export function detectFormat(content: string, filename?: string): string | null
export function parseCodexCsvToScans(content: string): { displayName: string, data: { type: string, source: string, findings: unknown[] } }[]

export function backfillFindingIds(findings: Record<string, unknown>[]): Promise<void>
