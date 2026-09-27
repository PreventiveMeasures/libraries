export const byNumbers = new Intl.Collator('en', { numeric: true }).compare
export const order = (a, b) => (a > b) - (a < b)
