// Settings › About › Open Source: the projects Zepper is built on, each with its license in full. Run
// before a release (`npm run dist` does): node scripts/licenses.mjs
//
// - Every npm package that ships: the runtime dependencies (packaged as they are) and the ones the
//   source imports (bundled into it), with everything they depend on in turn.
// - The rest, listed by hand below: Chromium, Electron and castLabs' build of it, the filter lists
//   and data Zepper downloads, and icons drawn from other sets.
// - Chromium's own credits (every component it's made of, Node.js and V8 among them) are packaged
//   compressed, to open in a tab.
//
// Writes src/renderer/src/overlay/open-source.generated.json and build/licenses/chromium.html.gz.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { gzipSync } from 'node:zlib'

const root = join(import.meta.dirname, '..')
const own = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const OUT = join(root, 'src', 'renderer', 'src', 'overlay', 'open-source.generated.json')
const CHROMIUM_OUT = join(root, 'build', 'licenses', 'chromium.html.gz')

/** Shipped as part of everything else rather than as a package (Electron is the runtime itself). */
const NOT_PACKAGES = new Set(['electron'])

/** Bare imports in the source: the packages bundled into Zepper. */
function importedPackages() {
  const found = new Set()
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
        const text = readFileSync(path, 'utf8')
        for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"./][^'"]*)['"]/gm)) {
          const spec = match[1]
          const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
          found.add(name)
        }
      }
    }
  }
  walk(join(root, 'src'))
  const known = { ...own.dependencies, ...own.devDependencies }
  return [...found].filter(
    (name) => name in known && !name.startsWith('@types/') && !builtinModules.includes(name) && !NOT_PACKAGES.has(name)
  )
}

/** Where a package resolves from a directory, as Node finds it. */
function resolvePackage(name, fromDir) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name, 'package.json')
    if (existsSync(candidate)) return dirname(candidate)
    if (dir === root || dirname(dir) === dir) return null
  }
}

const LICENSE_FILE = /^(licen[cs]e|copying|unlicense)([.\-_].*)?$/i
const NOTICE_FILE = /^notice([.\-_].*)?$/i

function filesMatching(dir, pattern) {
  return readdirSync(dir)
    .filter((name) => pattern.test(name) && statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n').trim())
    .filter(Boolean)
}

function licenseOf(pkg) {
  const license = pkg.license ?? pkg.licenses
  if (typeof license === 'string') return license
  if (Array.isArray(license)) return license.map((l) => l.type ?? l).join(' OR ')
  if (license && typeof license === 'object') return license.type ?? 'See license'
  return 'See license'
}

function authorOf(pkg) {
  const author = pkg.author
  if (typeof author === 'string') return author.replace(/\s*[<(].*$/, '').trim() || undefined
  return author?.name
}

/** A link to the project's page or code. */
function urlOf(pkg) {
  let repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  if (repo) {
    repo = repo
      .replace(/^git\+/, '')
      .replace(/\.git$/, '')
      .replace(/^git:\/\//, 'https://')
      .replace(/^ssh:\/\/git@/, 'https://')
    if (/^github:/.test(repo)) repo = `https://github.com/${repo.slice(7)}`
    else if (/^[\w.-]+\/[\w.-]+$/.test(repo)) repo = `https://github.com/${repo}`
    if (/^https?:\/\//.test(repo)) return repo
  }
  return typeof pkg.homepage === 'string' && /^https?:\/\//.test(pkg.homepage) ? pkg.homepage : undefined
}

const texts = []
const textIndex = new Map()
const textId = (text) => {
  if (!text) return undefined
  if (!textIndex.has(text)) {
    textIndex.set(text, texts.length)
    texts.push(text)
  }
  return textIndex.get(text)
}

// Licenses' own texts, for what doesn't come with its license's text: the GPL is Zepper's own.
const GPL = textId(readFileSync(join(root, 'LICENSE'), 'utf8').trim())
const APACHE = textId(readFileSync(join(root, 'node_modules', 'typescript', 'LICENSE.txt'), 'utf8').trim())
const MPL = (() => {
  const ghostery = readFileSync(join(root, 'node_modules', '@ghostery', 'adblocker', 'LICENSE'), 'utf8')
  return textId(ghostery.slice(ghostery.indexOf('Mozilla Public License')).trim())
})()
const MIT = (holder) => `MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

/** A package without its license's text: that license's standard text (MIT's naming its author). */
function standardText(license, author) {
  if (license === 'Apache-2.0') return APACHE
  if (/^GPL-3\.0/.test(license)) return GPL
  if (license === 'MIT' && author) return textId(MIT(author))
  return undefined
}

// Every package that ships, once per version.
const packages = new Map()
const missing = []
const visit = (name, fromDir) => {
  const dir = resolvePackage(name, fromDir)
  if (!dir) return
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const key = `${pkg.name}@${pkg.version}`
  if (packages.has(key)) return
  const licenseTexts = filesMatching(dir, LICENSE_FILE)
  const notices = filesMatching(dir, NOTICE_FILE)
  const license = licenseOf(pkg)
  const author = authorOf(pkg)
  const standard = licenseTexts.length === 0 ? standardText(license, author) : undefined
  if (licenseTexts.length === 0 && standard === undefined) missing.push(key)
  packages.set(key, {
    name: pkg.name,
    version: pkg.version,
    license,
    author,
    url: urlOf(pkg),
    text: standard ?? textId(licenseTexts.join('\n\n')),
    standard: standard !== undefined || undefined,
    notice: textId(notices.join('\n\n'))
  })
  for (const dep of [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})]) visit(dep, dir)
}
const roots = [...new Set([...Object.keys(own.dependencies ?? {}), ...importedPackages()])]
for (const name of roots) visit(name, root)

const electronDist = join(root, 'node_modules', 'electron', 'dist')
const electronVersion = JSON.parse(readFileSync(join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version

/**
 * One of the files Electron's runtime comes with (its license, Chromium's credits): from the runtime in
 * node_modules, or where that isn't installed (Linux packaging, which uses castLabs' runtimes), from
 * one of the runtimes scripts/stage-electron.mjs downloaded.
 */
function electronFile(name) {
  const installed = join(electronDist, name)
  if (existsSync(installed)) return readFileSync(installed)
  const cache = join(root, 'node_modules', '.cache')
  const zip =
    existsSync(cache) && readdirSync(cache).find((file) => file.startsWith(`electron-v${electronVersion}-`) && file.endsWith('.zip'))
  if (!zip) throw new Error(`No Electron runtime to read ${name} from: run npm install, or scripts/stage-electron.mjs`)
  return execFileSync('unzip', ['-p', join(cache, zip), name], { maxBuffer: 256 * 1024 * 1024 })
}

const ELECTRON = textId(electronFile('LICENSE').toString('utf8').trim())

// Not npm packages, or not only: what Zepper is made of and what it downloads.
const projects = [
  {
    group: 'Foundations',
    name: 'Chromium',
    license: 'BSD-3-Clause and others',
    author: 'The Chromium Authors',
    url: 'https://www.chromium.org/',
    detail: 'The browser engine. Its own credits list every component it is made of, Node.js and V8 among them.',
    chromiumCredits: true
  },
  {
    group: 'Foundations',
    name: 'Electron',
    version: electronVersion.replace(/\+.*$/, ''),
    license: 'MIT',
    author: 'Electron contributors',
    url: 'https://www.electronjs.org/',
    detail: 'Chromium and Node.js, made into an app.',
    text: ELECTRON
  },
  {
    group: 'Foundations',
    name: 'Electron for Content Security',
    license: 'MIT',
    author: 'castLabs',
    url: 'https://github.com/castlabs/electron-releases',
    detail: "castLabs' build of Electron, which can play protected video (with Widevine, when you turn it on).",
    text: ELECTRON
  },
  {
    group: 'Filter lists and data',
    name: 'Brave’s filter lists',
    license: 'MPL-2.0',
    author: 'Brave Software and contributors',
    url: 'https://github.com/brave/adblock-lists',
    detail:
      'Zepper blocks with the lists Brave Shields uses, Brave’s own among them: its fixes, first-party ads and cookie notices. Downloaded daily.',
    text: MPL
  },
  {
    group: 'Filter lists and data',
    name: 'Brave’s scripts',
    license: 'MPL-2.0',
    author: 'Brave Software and contributors',
    url: 'https://github.com/brave/adblock-resources',
    detail: 'The scripts Brave runs on some sites, its YouTube fixes among them. Downloaded daily.',
    text: MPL
  },
  {
    group: 'Filter lists and data',
    name: 'uBlock Origin filter lists and scriptlets',
    license: 'GPL-3.0',
    author: 'Raymond Hill and the uBlock Origin contributors',
    url: 'https://github.com/uBlockOrigin/uAssets',
    detail: "Ads, trackers, badware, link shorteners, YouTube's ads and cookie notices. Downloaded daily, most through Ghostery's copies.",
    text: GPL
  },
  {
    group: 'Filter lists and data',
    name: 'EasyList and EasyPrivacy',
    license: 'GPL-3.0 OR CC-BY-SA-3.0',
    author: 'The EasyList authors',
    url: 'https://easylist.to/',
    detail: 'Ads and trackers. Downloaded daily.',
    text: GPL
  },
  {
    group: 'Filter lists and data',
    name: 'Fanboy’s Cookiemonster and Mobile Notifications lists',
    license: 'CC-BY-3.0',
    author: 'Fanboy and the EasyList authors',
    url: 'https://easylist.to/',
    detail: 'Cookie notices and app promotions. Downloaded daily.',
    licenseUrl: 'https://creativecommons.org/licenses/by/3.0/'
  },
  {
    group: 'Filter lists and data',
    name: 'Malicious URL Blocklist (URLhaus)',
    license: 'CC0-1.0 AND MIT',
    author: 'curben (malware-filter), from abuse.ch’s URLhaus',
    url: 'https://gitlab.com/malware-filter/urlhaus-filter',
    detail: 'Sites spreading malware. Downloaded daily.',
    licenseUrl: 'https://gitlab.com/malware-filter/urlhaus-filter#license'
  },
  {
    group: 'Filter lists and data',
    name: 'DuckDuckGo bangs',
    license: "DuckDuckGo's terms",
    author: 'DuckDuckGo',
    url: 'https://duckduckgo.com/bangs',
    detail: 'The !bang shortcuts in the address bar: the most used ship with Zepper, the rest are downloaded.'
  },
  {
    group: 'Icons',
    name: 'Material Icons',
    license: 'Apache-2.0',
    author: 'Google',
    url: 'https://github.com/google/material-design-icons',
    detail: 'The puzzle piece (extensions) and Translate icons.',
    text: APACHE
  }
]

const data = {
  zepper: { license: own.license, text: GPL },
  projects,
  packages: [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)),
  texts
}
writeFileSync(OUT, JSON.stringify(data) + '\n')

mkdirSync(dirname(CHROMIUM_OUT), { recursive: true })
writeFileSync(CHROMIUM_OUT, gzipSync(electronFile('LICENSES.chromium.html'), { level: 9 }))

const size = (path) => `${Math.round(statSync(path).size / 1024)} KB`
console.log(
  `licenses: ${data.packages.length} packages and ${projects.length} other projects → ${relative(root, OUT)} (${size(OUT)}), ` +
    `Chromium's credits → ${relative(root, CHROMIUM_OUT)} (${size(CHROMIUM_OUT)})`
)
if (missing.length) console.log(`licenses: no license text for ${missing.join(', ')} (listed with their license's name)`)
