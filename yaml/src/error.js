// `line` counts from zero; the message counts from one.
export class YamlError extends Error {
  constructor(detail, line) {
    super(line === undefined ? detail : `${detail} at line ${line + 1}`)
    this.name = 'YamlError'
    this.line = line
  }
}

// A piece of the input for a message, quoted, and cut short where it runs
// long: a line may be a megabyte, and a message is for a person to read.
export const excerpt = (text) => (text.length > 64 ? `${JSON.stringify(text.slice(0, 64))}...` : JSON.stringify(text))
