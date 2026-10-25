declare module '*.png' {
  const src: string
  export default src
}

/** Data a script writes (its type is declared where it's read, not inferred from all of it). */
declare module '*.generated.json' {
  const data: unknown
  export default data
}
