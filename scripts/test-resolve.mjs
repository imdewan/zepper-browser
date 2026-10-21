// Lets the tests (plain Node) import TypeScript the way the app does, without extensions.
import { registerHooks } from 'node:module'

const shared = new URL('../src/shared/', import.meta.url).href

registerHooks({
  resolve(specifier, context, next) {
    // The @shared alias, as electron-vite resolves it.
    if (specifier.startsWith('@shared/')) specifier = shared + specifier.slice('@shared/'.length)
    try {
      return next(specifier, context)
    } catch (error) {
      if (!(specifier.startsWith('.') || specifier.startsWith('file:')) || /\.[a-z]+$/i.test(specifier)) throw error
      for (const suffix of ['.ts', '.tsx', '/index.ts']) {
        try {
          return next(specifier + suffix, context)
        } catch {
          // Try the next one.
        }
      }
      throw error
    }
  }
})
