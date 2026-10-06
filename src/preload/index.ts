import { contextBridge, ipcRenderer } from 'electron'
import { injectBrowserAction } from 'electron-chrome-extensions/browser-action'
import { IPC, type Command, type Snapshot, type UiEvent, type ZepperApi } from '../shared/types'

const api: ZepperApi = {
  platform: process.platform,
  getSnapshot: () => ipcRenderer.invoke(IPC.getSnapshot),
  onSnapshot(callback) {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: Snapshot): void => callback(snapshot)
    ipcRenderer.on(IPC.snapshot, listener)
    return () => ipcRenderer.removeListener(IPC.snapshot, listener)
  },
  onEvent(callback) {
    const listener = (_event: Electron.IpcRendererEvent, event: UiEvent): void => callback(event)
    ipcRenderer.on(IPC.event, listener)
    return () => ipcRenderer.removeListener(IPC.event, listener)
  },
  send: (command: Command) => ipcRenderer.send(IPC.command, command),
  suggest: (text: string) => ipcRenderer.invoke(IPC.suggest, text),
  history: (query: string) => ipcRenderer.invoke(IPC.history, query),
  historyMeaning: (query: string) => ipcRenderer.invoke(IPC.historyMeaning, query),
  extensions: () => ipcRenderer.invoke(IPC.extensions),
  vault: (request) => ipcRenderer.invoke(IPC.vault, request)
}

contextBridge.exposeInMainWorld('zepper', api)

// <browser-action-list>: extension toolbar buttons and popups.
injectBrowserAction()
