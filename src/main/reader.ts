import { createHash } from 'node:crypto'
import type { WebContents } from 'electron'
// Firefox's Reader View code, run on a copy of the page (Apache-2.0).
import READABILITY from '@mozilla/readability/Readability.js?raw'
import READERABLE from '@mozilla/readability/Readability-readerable.js?raw'
import type { ReaderTheme } from '@shared/settings'

/** A page's article, as Reader Mode shows it. */
export interface Article {
  title: string
  byline: string
  /** Readability's cleaned-up HTML of the article (scripts and styles gone). */
  content: string
  lang: string
  dir: string
}

export interface ReaderPrefs {
  size: number
  theme: ReaderTheme
}

/** The event the reader page sends its text size and theme in (the page preload passes it on). */
export const READER_PREFS_EVENT = 'zepper-reader-prefs'

/** Zepper's own isolated world for reading pages (out of reach of the page's scripts). */
const READER_WORLD = 1002

const ARTICLE_SCRIPT = `${READABILITY}
;${READERABLE}
;(() => {
  // Firefox's test for whether a page has an article at all (its Reader View button).
  if (!isProbablyReaderable(document)) return null
  const article = new Readability(document.cloneNode(true), { charThreshold: 400 }).parse()
  if (!article || !article.content || (article.length || 0) < 400) return null
  return {
    title: article.title || document.title || '',
    byline: article.byline || '',
    content: article.content,
    lang: article.lang || document.documentElement.lang || '',
    dir: article.dir || ''
  }
})()`

/** The page's article, or null if it doesn't have one Reader Mode can show (a home page, an app). */
export async function readArticle(wc: WebContents): Promise<Article | null> {
  try {
    return ((await wc.executeJavaScriptInIsolatedWorld(READER_WORLD, [{ code: ARTICLE_SCRIPT }])) as Article | null) ?? null
  } catch {
    return null
  }
}

const escape = (s: string): string => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)

/** The reader page's own script: text size, theme and Done (it has no access to anything else). */
const TOOLBAR_SCRIPT = `(() => {
  const root = document.documentElement
  const save = () => document.dispatchEvent(new CustomEvent('${READER_PREFS_EVENT}', { detail: JSON.stringify({ size: Number(root.dataset.size), theme: root.dataset.theme }) }))
  const size = (step) => { root.dataset.size = String(Math.min(30, Math.max(14, Number(root.dataset.size) + step))); root.style.setProperty('--size', root.dataset.size + 'px'); save() }
  document.getElementById('smaller').onclick = () => size(-2)
  document.getElementById('larger').onclick = () => size(2)
  for (const button of document.querySelectorAll('[data-set-theme]')) button.onclick = () => { root.dataset.theme = button.dataset.setTheme; save() }
  document.getElementById('done').onclick = () => history.back()
})()`
const TOOLBAR_HASH = createHash('sha256').update(TOOLBAR_SCRIPT).digest('base64')

/**
 * The reader page: Zepper's typography, the article put in once it has loaded (see fillReader), and
 * no scripts but the toolbar's (the article's own can't run). `token` makes each page's address its own.
 */
export function readerPage(token: string, article: Article, prefs: ReaderPrefs, site: string): string {
  const csp = `default-src 'none'; script-src 'sha256-${TOOLBAR_HASH}'; style-src 'unsafe-inline'; img-src * data: blob:; media-src *; font-src data:`
  const html = `<!doctype html><html lang="${escape(article.lang)}" dir="${escape(article.dir || 'auto')}" data-theme="${prefs.theme}" data-size="${prefs.size}" style="--size:${prefs.size}px">
<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="zepper-reader" content="${token}">
<title>${escape(article.title)}</title>
<style>
  :root { --bg: #fff; --text: #1d1d1f; --muted: #6e6e73; --rule: #e5e5ea; --link: #0a5bd6; --bar: rgba(255,255,255,.92); color-scheme: light; }
  :root[data-theme='sepia'] { --bg: #f8f1e3; --text: #3b3023; --muted: #7d6e5b; --rule: #e6dccb; --link: #8a4b0f; --bar: rgba(248,241,227,.92); }
  :root[data-theme='dark'] { --bg: #1c1c1e; --text: #e5e5e7; --muted: #98989d; --rule: #38383a; --link: #6aa7ff; --bar: rgba(28,28,30,.92); color-scheme: dark; }
  html { background: var(--bg); color: var(--text); }
  body { margin: 0; font: var(--size)/1.65 Charter, 'Iowan Old Style', Georgia, serif; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
  main { max-width: 680px; margin: 0 auto; padding: 72px 24px 120px; }
  header { margin-bottom: 32px; padding-bottom: 20px; border-bottom: 1px solid var(--rule); }
  .site { font: 500 14px/1.4 -apple-system, system-ui, sans-serif; color: var(--muted); }
  h1.title { font: 700 calc(var(--size) * 1.7)/1.2 -apple-system, system-ui, sans-serif; margin: 8px 0 10px; letter-spacing: -.01em; text-wrap: balance; }
  .byline { font: 15px/1.4 -apple-system, system-ui, sans-serif; color: var(--muted); }
  article h1, article h2, article h3, article h4 { font-family: -apple-system, system-ui, sans-serif; line-height: 1.3; margin: 1.6em 0 .5em; text-wrap: balance; }
  article p, article ul, article ol, article blockquote, article pre, article figure, article table { margin: 0 0 1em; }
  article a { color: var(--link); text-decoration: none; }
  article a:hover { text-decoration: underline; }
  article img, article video, article svg { max-width: 100%; height: auto; border-radius: 6px; }
  article figure { margin-inline: 0; }
  article figcaption { font: 14px/1.45 -apple-system, system-ui, sans-serif; color: var(--muted); margin-top: 6px; }
  article blockquote { border-left: 3px solid var(--rule); margin-inline: 0; padding-left: 1em; color: var(--muted); }
  article pre, article code { font: .85em/1.5 ui-monospace, Menlo, monospace; }
  article pre { overflow-x: auto; padding: 12px 14px; border-radius: 8px; background: color-mix(in srgb, var(--text) 6%, transparent); }
  article table { border-collapse: collapse; display: block; overflow-x: auto; font-size: .9em; }
  article td, article th { border: 1px solid var(--rule); padding: 6px 10px; }
  article table p { margin: 0 0 .3em; }
  /* Wikipedia's geologic timeline: a row of eras, not a column. */
  article #Timeline-row { display: flex; flex-wrap: wrap; gap: 2px 6px; justify-content: center; font-size: .75em; }
  article #Timeline-row p { margin: 0; }
  article hr { border: 0; border-top: 1px solid var(--rule); }
  nav { position: fixed; top: 12px; right: 12px; display: flex; gap: 4px; align-items: center; padding: 4px; border-radius: 12px; background: var(--bar); backdrop-filter: blur(12px); border: 1px solid var(--rule); font: 13px/1 -apple-system, system-ui, sans-serif; }
  nav button { appearance: none; border: 0; background: transparent; color: var(--text); font: inherit; height: 28px; min-width: 28px; padding: 0 8px; border-radius: 8px; cursor: pointer; }
  nav button:hover { background: color-mix(in srgb, var(--text) 9%, transparent); }
  nav .swatch { width: 18px; height: 18px; min-width: 18px; padding: 0; border-radius: 50%; border: 1px solid rgba(128,128,128,.55); margin: 0 3px; }
  :root[data-theme='light'] [data-set-theme='light'], :root[data-theme='sepia'] [data-set-theme='sepia'], :root[data-theme='dark'] [data-set-theme='dark'] { box-shadow: 0 0 0 2px var(--bg), 0 0 0 3.5px var(--link); }
  nav .sep { width: 1px; height: 18px; background: var(--rule); margin: 0 2px; }
  #done { font-weight: 600; }
</style>
<nav>
  <button id="smaller" title="Smaller text">A−</button><button id="larger" title="Larger text">A+</button><span class="sep"></span>
  <button class="swatch" data-set-theme="light" title="Light" style="background:#fff"></button><button class="swatch" data-set-theme="sepia" title="Sepia" style="background:#f8f1e3"></button><button class="swatch" data-set-theme="dark" title="Dark" style="background:#1c1c1e"></button><span class="sep"></span>
  <button id="done" title="Back to the page">Done</button>
</nav>
<main><header>${site ? `<div class="site">${escape(site)}</div>` : ''}<h1 class="title">${escape(article.title)}</h1>${article.byline ? `<div class="byline">${escape(article.byline)}</div>` : ''}</header><article id="article"></article></main>
<script>${TOOLBAR_SCRIPT}</script>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

/** Puts the article in the reader page (it's too big to go in the page's address). */
export function fillReader(wc: WebContents, article: Article): Promise<unknown> {
  return wc.executeJavaScript(`document.getElementById('article').innerHTML = ${JSON.stringify(article.content)}`, false).catch(() => null)
}
