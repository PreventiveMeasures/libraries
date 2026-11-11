// A refusal of input pod does not take, never guessed around. `where` names what it is about.
export class PodError extends Error {
  constructor(detail, where, options) {
    super(where === undefined ? detail : `${where}: ${detail}`, options)
    this.name = 'PodError'
    this.detail = detail
    this.where = where
  }
}

export const quote = (text) => JSON.stringify(text)
