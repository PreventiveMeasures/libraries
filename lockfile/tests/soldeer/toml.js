// A value as parseToml makes it: each object a table, of a null prototype,
// as the config the reader takes is.
export const toml = (value) => (typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.assign(Object.create(null), Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toml(item)]))) : value)
