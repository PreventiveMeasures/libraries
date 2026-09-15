// The lines that tell one of diff's output styles from ordinary text, and
// that say where a hunk begins and how far it reaches. They are the one
// thing reading a diff and colouring one have in common: a colouriser only
// asks whether a line is one of these, a reader also wants the numbers out
// of it, and both want the same answer to the first question.
//
// Kept together because they had drifted apart. The colouriser's fence was
// anchored to exactly fifteen stars and nothing after them, so a context
// diff made with -p — which writes the function name on the fence — was not
// recognised as a diff at all, and came out unpainted.
//
// A line may or may not carry its terminator: text split for display has
// none, records read for parsing do, so the patterns allow either.

export const UNIFIED_HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: ?(.*?))?\n?$/u
export const CONTEXT_FENCE = /^\*{15,}(?: (.*?))?\n?$/u
export const CONTEXT_OLD = /^\*{3} (\d+)(?:,(\d+))? \*{4}\n?$/u
export const CONTEXT_NEW = /^--- (\d+)(?:,(\d+))? ----\n?$/u
export const NORMAL_COMMAND = /^(\d+)(?:,(\d+))?([acd])(\d+)(?:,(\d+))?[ \t]*\r?\n?$/u
