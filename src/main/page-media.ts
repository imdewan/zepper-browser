/**
 * For a script run in a page: defines `zepperFind(selector)`, the elements matching `selector` in the
 * document and in its open shadow roots, where players built as web components keep their video.
 */
export const FIND_IN_SHADOWS = `const zepperFind = (selector) => {
  const found = Array.from(document.querySelectorAll(selector))
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (!el.shadowRoot) continue
      found.push(...el.shadowRoot.querySelectorAll(selector))
      walk(el.shadowRoot)
    }
  }
  walk(document)
  return found
}`
