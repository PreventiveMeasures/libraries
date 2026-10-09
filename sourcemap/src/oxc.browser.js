// A browser bundle takes oxc-parser as any import, its own browser build
// (WASM) by its `browser` condition; one left out fails the build, not a
// call.
import * as oxc from 'oxc-parser'

export const getParser = () => oxc
