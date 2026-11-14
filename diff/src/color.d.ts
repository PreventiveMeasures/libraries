/**
 * What part each line of a diff plays, for the caller to paint
 *
 * ```js
 * import { diffFormat, diffLineStyles } from '@preventive/diff/color.js'
 * ```
 *
 * Read from markers a real diff emits and ordinary text does not, so a file full of `+` bullets or `---`
 * rules stays plain.
 *
 * @module @preventive/diff/color.js
 */

export type DiffFormat = 'unified' | 'context' | 'normal';

/** A line's part, as node:util's styleText names styles */
export type DiffStyle = 'bold' | 'cyan' | 'green' | 'red' | 'yellow' | 'gray';

/**
 * The format a text is written in; a diff quoted in it counts
 *
 * @param text - Any text
 * @returns The format, or null for text that is not a diff
 */
export function diffFormat(text: string): DiffFormat | null;

/**
 * Each line's style
 *
 * @param text - Any text
 * @returns One entry per line of `text.split('\n')`, null where a line takes none; null for text that is not a diff
 */
export function diffLineStyles(text: string): (DiffStyle | null)[] | null;
