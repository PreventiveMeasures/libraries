// The lines that mark each format and say where a hunk starts and how far it reaches.
// Records read for parsing carry their terminator and lines split for display do not, so either matches.
export const UNIFIED_HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: ?(.*?))?\n?$/u
export const CONTEXT_FENCE = /^\*{15,}(?: (.*?))?\n?$/u
export const CONTEXT_OLD = /^\*{3} (\d+)(?:,(\d+))? \*{4}\n?$/u
export const CONTEXT_NEW = /^--- (\d+)(?:,(\d+))? ----\n?$/u
export const NORMAL_COMMAND = /^(\d+)(?:,(\d+))?([acd])(\d+)(?:,(\d+))?[ \t]*\r?\n?$/u
