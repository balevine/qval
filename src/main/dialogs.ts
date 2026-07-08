import { BrowserWindow, dialog } from 'electron'

/**
 * Native file-dialog helpers, parented to the sender's window when it can be resolved (so the
 * dialog is sheet-attached on macOS) and app-modal otherwise. Shared by `ipc.ts` and `storage.ts`.
 */

export function showOpen(sender: Electron.WebContents, options: Electron.OpenDialogOptions) {
  const win = BrowserWindow.fromWebContents(sender)
  return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options)
}

export function showSave(sender: Electron.WebContents, options: Electron.SaveDialogOptions) {
  const win = BrowserWindow.fromWebContents(sender)
  return win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options)
}
