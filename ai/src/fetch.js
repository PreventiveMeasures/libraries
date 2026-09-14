import { Agent, fetch as undiciFetch } from 'undici'

// 1 hour
const timeout = 3600e3

const dispatcher = new Agent({
  bodyTimeout: timeout,
  headersTimeout: timeout,
})

export const fetch = (url, options) => undiciFetch(url, { dispatcher, ...options })
