import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IpcChannels, type EvaluationProgress, type IpcApi, type ProviderId } from '@shared/types'

/**
 * The allow-listed API surface exposed to the renderer. Nothing else from Node or Electron is
 * reachable from the renderer (contextIsolation + sandbox are on). Grows alongside `IpcApi`.
 */
const api: IpcApi = {
  app: {
    getVersion: () => ipcRenderer.invoke(IpcChannels.appGetVersion)
  },
  settings: {
    get: () => ipcRenderer.invoke(IpcChannels.settingsGet),
    set: (partial) => ipcRenderer.invoke(IpcChannels.settingsSet, partial)
  },
  secrets: {
    setKey: (provider: ProviderId, key: string) =>
      ipcRenderer.invoke(IpcChannels.secretsSetKey, provider, key),
    hasKey: (provider: ProviderId) => ipcRenderer.invoke(IpcChannels.secretsHasKey, provider),
    clearKey: (provider: ProviderId) => ipcRenderer.invoke(IpcChannels.secretsClearKey, provider),
    status: () => ipcRenderer.invoke(IpcChannels.secretsStatus)
  },
  provider: {
    testConnection: (provider: ProviderId) =>
      ipcRenderer.invoke(IpcChannels.providerTestConnection, provider)
  },
  ollama: {
    listModels: (host: string) => ipcRenderer.invoke(IpcChannels.ollamaListModels, host)
  },
  anthropic: {
    listModels: () => ipcRenderer.invoke(IpcChannels.anthropicListModels)
  },
  session: {
    open: () => ipcRenderer.invoke(IpcChannels.sessionOpen),
    newEvaluation: () => ipcRenderer.invoke(IpcChannels.sessionNewEvaluation),
    loadLast: () => ipcRenderer.invoke(IpcChannels.sessionLoadLast),
    save: () => ipcRenderer.invoke(IpcChannels.sessionSave),
    addComparison: () => ipcRenderer.invoke(IpcChannels.sessionAddComparison),
    removeComparison: (id: string) => ipcRenderer.invoke(IpcChannels.sessionRemoveComparison, id),
    exportReport: () => ipcRenderer.invoke(IpcChannels.sessionExportReport)
  },
  evaluation: {
    estimate: (mode) => ipcRenderer.invoke(IpcChannels.evaluationEstimate, mode),
    start: (mode) => ipcRenderer.invoke(IpcChannels.evaluationStart, mode),
    cancel: () => ipcRenderer.invoke(IpcChannels.evaluationCancel),
    onProgress: (cb: (p: EvaluationProgress) => void) => {
      const listener = (_e: IpcRendererEvent, progress: EvaluationProgress) => cb(progress)
      ipcRenderer.on(IpcChannels.evaluationProgress, listener)
      return () => ipcRenderer.removeListener(IpcChannels.evaluationProgress, listener)
    }
  },
  human: {
    setValues: (ticketId, values) => ipcRenderer.invoke(IpcChannels.humanSetValues, ticketId, values)
  },
  dialog: {
    chooseDirectory: () => ipcRenderer.invoke(IpcChannels.dialogChooseDirectory)
  }
}

contextBridge.exposeInMainWorld('api', api)
