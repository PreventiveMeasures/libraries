// Strongly connected components, as pnpm finds the cycles of peers it
// collapses (@pnpm/lockfile, next_format/tarjan.rs): the nodes of
// `0..count` that `participates` takes, by the edges `neighbors` gives, to
// such nodes alone. `components` holds each node that does not take part
// alone first, then each component after every component it has an edge
// to; `componentOf` gives a taking part node's index among them.

export function components(count, neighbors, participates) {
  const index = Array.from({ length: count }, () => undefined)
  const low = Array.from({ length: count }, () => 0)
  const onStack = Array.from({ length: count }, () => false)
  const stack = []
  const found = { components: [], componentOf: new Map() }
  for (let node = 0; node < count; node++) if (!participates(node)) found.components.push([node])
  let next = 0
  const frames = []
  const enter = (node) => {
    index[node] = low[node] = next++
    stack.push(node)
    onStack[node] = true
    frames.push({ node, edges: neighbors(node).filter(participates), position: 0 })
  }
  const leave = () => {
    const { node } = frames.pop()
    if (frames.length > 0) {
      const parent = frames.at(-1).node
      low[parent] = Math.min(low[parent], low[node])
    }
    if (low[node] !== index[node]) return
    const component = []
    for (;;) {
      const member = stack.pop()
      onStack[member] = false
      found.componentOf.set(member, found.components.length)
      component.push(member)
      if (member === node) break
    }
    found.components.push(component)
  }
  for (let root = 0; root < count; root++) {
    if (!participates(root) || index[root] !== undefined) continue
    enter(root)
    while (frames.length > 0) {
      const frame = frames.at(-1)
      if (frame.position === frame.edges.length) {
        leave()
        continue
      }
      const to = frame.edges[frame.position++]
      if (index[to] === undefined) enter(to)
      else if (onStack[to]) low[frame.node] = Math.min(low[frame.node], index[to])
    }
  }
  return found
}
