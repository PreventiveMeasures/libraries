// `line` counts from zero; the message counts from one.
export class YamlError extends Error {
  constructor(detail, line) {
    super(line === undefined ? detail : `${detail} at line ${line + 1}`)
    this.name = 'YamlError'
    this.line = line
  }
}
