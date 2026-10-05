import { useEffect, useState } from 'react'
import type { Settings } from '@shared/settings'
import type { ExtensionInfo } from '@shared/types'
import { zepper } from '../bridge'
import { extensionIconUrl } from '../extensions'
import { IconPin } from '../icons'
import { cx } from '../util'
import { Toggle } from './Toggle'

/** Settings → Extensions, like Chrome's: turn extensions on or off, pin, open their settings, remove. */
export function ExtensionsSettings({ settings }: { settings: Settings }): React.JSX.Element {
  const [list, setList] = useState<ExtensionInfo[] | null>(null)
  const refresh = (): void => {
    void zepper.extensions().then(setList)
  }
  useEffect(refresh, [settings.disabledExtensions])

  const act = (command: Parameters<typeof zepper.send>[0]): void => {
    zepper.send(command)
    // Loading and unloading take a moment; refresh once it has happened.
    setTimeout(refresh, 400)
  }
  const togglePin = (id: string): void => {
    const pinned = settings.pinnedExtensions
    zepper.send({ type: 'settings.update', patch: { pinnedExtensions: pinned.includes(id) ? pinned.filter((p) => p !== id) : [...pinned, id] } })
  }

  return (
    <>
      <h2>Extensions</h2>
      <div className="settings-row">
        <div className="settings-row-text">
          <div className="settings-row-label">Show extensions row</div>
          <div className="settings-row-hint">Pinned extensions get their own row under the address bar.</div>
        </div>
        <div className="settings-row-control">
          <Toggle checked={settings.extensionsRow} onChange={(extensionsRow) => zepper.send({ type: 'settings.update', patch: { extensionsRow } })} />
        </div>
      </div>
      <div className="ext-list">
        {list !== null && list.length === 0 && <p className="ext-empty">No extensions yet.</p>}
        {list?.map((ext) => {
          const pinned = settings.pinnedExtensions.includes(ext.id)
          return (
            <div key={ext.id} className={cx('ext-card', !ext.enabled && 'off')}>
              <ExtensionIcon id={ext.id} name={ext.name} enabled={ext.enabled} />
              <div className="ext-text">
                <div className="ext-name">
                  {ext.name} <span className="ext-version">{ext.version}</span>
                </div>
                {ext.description && <div className="ext-description">{ext.description}</div>}
                <div className="ext-actions">
                  {ext.enabled && ext.hasOptions && (
                    <button className="ext-link" onClick={() => act({ type: 'extension.options', id: ext.id })}>
                      Options
                    </button>
                  )}
                  <button className="ext-link danger" onClick={() => act({ type: 'extension.remove', id: ext.id })}>
                    Remove
                  </button>
                </div>
              </div>
              {ext.enabled && (
                <button className={cx('ext-pin', pinned && 'pinned')} title={pinned ? 'Unpin' : 'Pin'} onClick={() => togglePin(ext.id)}>
                  <IconPin size={14} />
                </button>
              )}
              <Toggle checked={ext.enabled} onChange={(enabled) => act({ type: 'extension.setEnabled', id: ext.id, enabled })} />
            </div>
          )
        })}
      </div>
      <button className="ext-store" onClick={() => zepper.send({ type: 'tab.open', input: 'https://chromewebstore.google.com', where: 'new' })}>
        Get extensions from the Chrome Web Store
      </button>
    </>
  )
}

function ExtensionIcon({ id, name, enabled }: { id: string; name: string; enabled: boolean }): React.JSX.Element {
  const [failed, setFailed] = useState(!enabled)
  return failed ? (
    <span className="ext-icon letter">{name.charAt(0).toUpperCase()}</span>
  ) : (
    <img className="ext-icon" src={extensionIconUrl(id, undefined)} alt="" onError={() => setFailed(true)} draggable={false} />
  )
}
