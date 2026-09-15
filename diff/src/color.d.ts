// The typed contract for the second entry point, @preventive/diff/color.js.
// Hand-written, and unchecked against the implementation: a change to a
// signature there belongs in the same commit as the change here.

// The three output styles, told apart by their structural markers.
export type DiffFormat = 'unified' | 'context' | 'normal'

// The part a line plays, named as node:util's styleText names it. Nothing
// in the module depends on that module; the caller does the painting.
export type DiffStyle = 'bold' | 'cyan' | 'green' | 'red' | 'yellow' | 'gray'

// null for text that is not a diff.
export function diffFormat(text: string): DiffFormat | null

// One entry per line of `text.split('\n')`, null where a line takes no
// style; null in place of the array when the text is not a diff.
export function diffLineStyles(text: string): (DiffStyle | null)[] | null
