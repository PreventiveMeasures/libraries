// FROZEN identity contract: hash the source row and complete finding partition,
// never parsed severity, title, evidence, repository, or other display fields.
// Newline normalization and trimming the partition boundaries are the only
// normalization. Key order is part of the fingerprint. Keep the golden IDs in
// finding-id-generic-md.test.js stable when changing the presentation parser.
export function genericMarkdownIdBasis(row, section) {
  return { source: 'markdown-generic', row: row.trim(), section: section.trim() }
}
