import { app, dialog, shell, type BrowserWindow } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { VaultReplies, VaultRequest } from '@shared/types'
import type { History } from './history'
import { entriesFromCsv, importFromBrowser, importHistory, importOpenTabs, importSources } from './importers'
import type { ImportedSession } from './session-import'
import { verifyOwner } from './native'
import type { SettingsStore } from './settings-store'
import type { Vault } from './vault'

/**
 * Settings › Passwords: listing, editing and deleting saved passwords and passkeys, importing from
 * other browsers and password exports, and exporting. Showing or exporting passwords asks for
 * Touch ID (or your Mac's password) first, then not again for a couple of minutes.
 */

const UNLOCKED_FOR_MS = 2 * 60_000
let unlockedUntil = 0

async function unlock(reason: string): Promise<boolean> {
  if (Date.now() < unlockedUntil) return true
  const result = await verifyOwner(reason).catch(() => false as const)
  // A Mac with no way to check (no password set) has nothing to protect them with.
  if (result === true || result === 'unavailable') {
    unlockedUntil = Date.now() + UNLOCKED_FOR_MS
    return true
  }
  return false
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** When macOS kept the Keychain key from Zepper (see Vault.unavailable). */
const UNAVAILABLE =
  'Zepper can’t open your saved passwords right now. Quit and reopen Zepper, and choose Allow when macOS asks about its Keychain key.'

export async function handleVaultRequest(
  vault: Vault,
  history: History,
  settings: SettingsStore,
  win: BrowserWindow,
  request: VaultRequest,
  /** Puts imported tabs into the window that asked (its spaces). */
  importSession: (session: ImportedSession, browserName: string) => { tabs: number; spaces: number }
): Promise<VaultReplies[VaultRequest['type']]> {
  await vault.ready()
  switch (request.type) {
    case 'list':
      return { logins: vault.listLogins(), passkeys: vault.listPasskeys(), unavailable: vault.unavailable }
    case 'reveal': {
      const login = vault.login(String(request.id))
      if (!login) return { error: 'That password is no longer saved.' }
      if (!(await unlock('show your saved passwords'))) return { error: 'Not unlocked.' }
      return { password: login.password }
    }
    case 'add': {
      if (vault.unavailable) return { error: UNAVAILABLE }
      const username = String(request.username ?? '').trim()
      if (vault.findLogin(String(request.url ?? ''), username)) return { error: 'That account is already saved for this site.' }
      return vault.saveLogin(String(request.url ?? ''), username, String(request.password ?? ''))
        ? {}
        : { error: 'Enter a website address and a password.' }
    }
    case 'update': {
      const error = vault.updateLogin(String(request.id), {
        url: String(request.url ?? ''),
        username: String(request.username ?? '').trim(),
        password: request.password === undefined ? undefined : String(request.password),
        note: request.note === undefined ? undefined : String(request.note)
      })
      return error ? { error } : {}
    }
    case 'delete':
      vault.deleteLogin(String(request.id))
      return {}
    case 'deletePasskey':
      vault.deletePasskey(String(request.id))
      return {}
    case 'sources':
      return importSources()
    case 'importBrowser': {
      if (vault.unavailable) return { error: UNAVAILABLE }
      try {
        const { entries, neverSave } = await importFromBrowser(String(request.source), String(request.profile))
        const result = vault.importLogins(entries)
        const list = settings.get().neverSavePasswords
        const added = neverSave.filter((site) => !list.includes(site))
        if (added.length) settings.update({ neverSavePasswords: [...list, ...added] })
        return result
      } catch (error) {
        return { error: message(error) }
      }
    }
    case 'importHistory': {
      try {
        return history.importVisits(await importHistory(String(request.source), String(request.profile)))
      } catch (error) {
        return { error: message(error) }
      }
    }
    case 'importTabs': {
      try {
        const { session, name } = importOpenTabs(String(request.source), String(request.profile))
        if (session.groups.every((g) => g.tabs.length + g.pinned.length === 0) && session.essentials.length === 0)
          return { error: `${name} has no open tabs to bring over.` }
        return importSession(session, name)
      } catch (error) {
        return { error: message(error) }
      }
    }
    case 'importFile': {
      if (vault.unavailable) return { error: UNAVAILABLE }
      const choice = await dialog.showOpenDialog(win, {
        title: 'Import Passwords',
        buttonLabel: 'Import',
        message: 'Choose a passwords file exported from Apple Passwords, Safari, Firefox, Chrome or a password manager.',
        filters: [{ name: 'Passwords (CSV)', extensions: ['csv'] }],
        properties: ['openFile']
      })
      if (choice.canceled || !choice.filePaths[0]) return null
      try {
        return vault.importLogins(entriesFromCsv(await readFile(choice.filePaths[0], 'utf8')))
      } catch (error) {
        return { error: message(error) }
      }
    }
    case 'openPrivacySettings':
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles')
      return {}
    case 'export': {
      if (!(await unlock('export your saved passwords'))) return { saved: null, error: 'Not unlocked.' }
      const choice = await dialog.showSaveDialog(win, {
        title: 'Export Passwords',
        defaultPath: join(app.getPath('downloads'), 'Zepper Passwords.csv'),
        message: 'Anyone with this file can read your passwords. Delete it once you’ve imported it.',
        filters: [{ name: 'Passwords (CSV)', extensions: ['csv'] }]
      })
      if (choice.canceled || !choice.filePath) return { saved: null }
      try {
        await writeFile(choice.filePath, vault.exportCsv(), { mode: 0o600 })
        return { saved: choice.filePath }
      } catch (error) {
        return { saved: null, error: message(error) }
      }
    }
  }
}
