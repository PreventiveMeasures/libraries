import assert from 'node:assert/strict'

export const utf8 = (text) => new TextEncoder().encode(text)

// Two byte strings, the same or the first place they are not — said in
// blocks, since that is how an archive is read.
export function assertBytes(got, want, what = 'the bytes') {
  assert.ok(got instanceof Uint8Array, `${what} are not a Uint8Array`)
  const shorter = Math.min(got.length, want.length)
  for (let i = 0; i < shorter; i++) {
    if (got[i] !== want[i]) assert.fail(`${what} differ at byte ${i} (block ${Math.floor(i / 512)}, offset ${i % 512}): got 0x${got[i].toString(16)}, wanted 0x${want[i].toString(16)}`)
  }
  assert.equal(got.length, want.length, `${what} differ in length`)
}

// A recording's entries with their data as bytes, which is what pack()
// takes and what unpack() gives back.
export const entriesOf = (recording) => recording.entries.map((entry) => ({ ...entry, data: utf8(entry.data) }))

// Entries with data as text, for a deep comparison that says something
// when it fails, and with the fields an entry is given alone: what the
// archive stored besides is looked at on its own.
const STORED = new Set(['storedName', 'storedLinkname', 'pax', 'globalPax'])
export const readable = (entries) => entries.map((entry) => ({
  ...Object.fromEntries(Object.entries(entry).filter(([key]) => !STORED.has(key))),
  data: new TextDecoder().decode(entry.data),
}))
