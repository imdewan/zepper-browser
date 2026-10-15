/** A file's text, bundled at build time (Vite's ?raw imports). */
declare module '*?raw' {
  const text: string
  export default text
}
