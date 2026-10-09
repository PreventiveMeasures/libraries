import { metroEdges } from './metro.js'
import { referenceEdges } from './references.js'

export const bundleEdges = (code, map) => ({ edges: metroEdges(code, map) ?? referenceEdges(code, map) })
