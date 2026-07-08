import { userInfo } from 'os'
import { app, ipcMain } from 'electron'
import { ALL_PROVIDERS, IpcChannels, type ProviderId } from '@shared/types'
import { validateValues } from '@shared/evalValidate'
import { SettingsStore } from './settings'
import { SecretStore } from './secrets'
import { listAnthropicModels, listOllamaModels, testConnection } from './connection'
import { Workspace } from './storage'
import { EvaluationService } from './evaluation/service'
import { showOpen } from './dialogs'

/** Validate an untrusted provider id from the renderer before it reaches the store/adapters. */
function assertProviderId(value: unknown): ProviderId {
  if (typeof value === 'string' && (ALL_PROVIDERS as string[]).includes(value)) {
    return value as ProviderId
  }
  throw new Error(`Unknown provider: ${String(value)}`)
}

/**
 * Registers all IPC handlers. Keep every channel here and allow-listed in the preload bridge —
 * the renderer can only reach what is explicitly exposed. Input from the renderer is validated
 * in main; API keys are decrypted here and never returned to the renderer.
 */
export function registerIpcHandlers(): void {
  const userData = app.getPath('userData')
  const settings = new SettingsStore(userData)
  const secrets = new SecretStore(userData)
  const workspace = new Workspace(settings, userData, app.getVersion())
  const evaluation = new EvaluationService(settings, secrets, workspace)

  // The working file is read-only while an LLM run is in flight: block every mutation (human edits,
  // settings/config changes, and file open/new/merge that would swap the file out from under the run)
  // so the run and the user never race for the same file. Everything is strictly sequential.
  const assertIdle = (): void => {
    if (evaluation.isRunning()) {
      throw new Error('An evaluation is running — wait for it to finish (or cancel it) before changing the file.')
    }
  }

  // Default the evaluator display name to the OS username on first run, so the renderer always
  // has a name for the human evaluator (editable in Settings).
  void (async () => {
    const s = await settings.get()
    if (!s.evaluatorName) {
      let username = 'Me'
      try {
        username = userInfo().username || 'Me'
      } catch {
        /* userInfo can throw in some sandboxes — keep the default */
      }
      await settings.set({ evaluatorName: username })
    }
  })()

  // --- App version ------------------------------------------------------------
  ipcMain.handle(IpcChannels.appGetVersion, () => app.getVersion())

  // --- Settings ---------------------------------------------------------------
  ipcMain.handle(IpcChannels.settingsGet, () => settings.get())
  ipcMain.handle(IpcChannels.settingsSet, async (_e, partial) => {
    assertIdle()
    const next = await settings.set(partial)
    // Keep an unlocked working file's config snapshot in sync as the user edits schema/rules, so
    // its fingerprint stays honest until the first score freezes it (spec §3/§4).
    if (partial && typeof partial === 'object' && ('schema' in partial || 'rules' in partial)) {
      await workspace.ensureConfigStamped()
    }
    return next
  })

  // --- Secrets (keys never returned to the renderer) --------------------------
  ipcMain.handle(IpcChannels.secretsSetKey, (_e, provider: unknown, key: unknown) =>
    secrets.setKey(assertProviderId(provider), String(key ?? ''))
  )
  ipcMain.handle(IpcChannels.secretsHasKey, (_e, provider: unknown) =>
    secrets.hasKey(assertProviderId(provider))
  )
  ipcMain.handle(IpcChannels.secretsClearKey, (_e, provider: unknown) =>
    secrets.clearKey(assertProviderId(provider))
  )
  ipcMain.handle(IpcChannels.secretsStatus, () => secrets.status())

  // --- Provider connectivity --------------------------------------------------
  ipcMain.handle(IpcChannels.providerTestConnection, async (_e, provider: unknown) => {
    const current = await settings.get()
    return testConnection(assertProviderId(provider), {
      host: current.ollama.host,
      getKey: (p) => secrets.getKey(p)
    })
  })
  ipcMain.handle(IpcChannels.ollamaListModels, (_e, host: unknown) => listOllamaModels(String(host ?? '')))
  ipcMain.handle(IpcChannels.anthropicListModels, async () => {
    const key = await secrets.getKey('anthropic')
    if (!key) throw new Error('Save an Anthropic API key first.')
    return listAnthropicModels(key)
  })

  // --- Session (dataset import + working eval file) ---------------------------
  ipcMain.handle(IpcChannels.sessionOpen, (e) => {
    assertIdle()
    return workspace.open(e.sender)
  })
  ipcMain.handle(IpcChannels.sessionNewEvaluation, (e) => {
    assertIdle()
    return workspace.newEvaluation(e.sender)
  })
  ipcMain.handle(IpcChannels.sessionLoadLast, () => workspace.loadLast())
  ipcMain.handle(IpcChannels.sessionSave, (e) => workspace.save(e.sender))
  ipcMain.handle(IpcChannels.sessionAddComparison, (e) => {
    assertIdle()
    return workspace.addComparison(e.sender)
  })
  ipcMain.handle(IpcChannels.sessionRemoveComparison, (_e, id: unknown) => workspace.removeComparison(String(id)))
  ipcMain.handle(IpcChannels.sessionExportReport, (e) => workspace.exportReport(e.sender))

  // --- Evaluation (LLM run) ---------------------------------------------------
  ipcMain.handle(IpcChannels.evaluationEstimate, (_e, mode) => evaluation.estimate(mode))
  ipcMain.handle(IpcChannels.evaluationStart, (e, mode) =>
    evaluation.start(mode, (progress) => {
      if (!e.sender.isDestroyed()) e.sender.send(IpcChannels.evaluationProgress, progress)
    })
  )
  ipcMain.handle(IpcChannels.evaluationCancel, () => {
    evaluation.cancel()
  })

  // --- Human evaluation -------------------------------------------------------
  ipcMain.handle(IpcChannels.humanSetValues, async (_e, ticketId: unknown, values: unknown) => {
    assertIdle()
    if (typeof ticketId !== 'number' || !Number.isFinite(ticketId)) throw new Error('Invalid ticket id.')
    const s = await settings.get()
    // Re-validate against the file's authoritative schema (matches the form the human is filling and
    // any frozen/loaded config) — a compromised renderer can't persist off-schema data.
    const schema = workspace.currentWorkingFile()?.meta.config.schema ?? s.schema
    const { values: clean } = validateValues(values, schema)
    await workspace.applyHumanEdit({ ticketId, values: clean, name: s.evaluatorName || 'Me' })
  })

  // --- Native dialogs ---------------------------------------------------------
  ipcMain.handle(IpcChannels.dialogChooseDirectory, async (e) => {
    const result = await showOpen(e.sender, {
      title: 'Choose default folder for eval files',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}
