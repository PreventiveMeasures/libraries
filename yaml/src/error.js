// Thrown at a document the parser does not read: malformed YAML and the YAML
// it refuses alike, since to a caller both are one thing — a file that is not
// what it was promised. `line` counts from zero; the message counts from one.
export class YamlError extends Error {
  constructor(detail, line) {
    super(line === undefined ? detail : `${detail} at line ${line + 1}`)
    this.name = 'YamlError'
    this.line = line
  }
}
