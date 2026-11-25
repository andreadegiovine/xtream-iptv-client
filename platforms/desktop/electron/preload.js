/* Preload of the desktop window: the page may only ask the main process for the full-screen state of its own window, to bring it to
 * the front (a scheduled viewing notification was clicked) and to keep the files of an update in its two slots. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('xtreamDesktop', {
  /** Switches full screen; resolves with whether the window is full screen now. */
  toggleFullscreen: () => ipcRenderer.invoke('window:fullscreen', true),
  isFullscreen: () => ipcRenderer.invoke('window:fullscreen', false),
  /** Restores and focuses the window. */
  show: () => ipcRenderer.invoke('window:show'),
  /** The computer's id (the trial builds' licence): the same across reinstalls of the app. */
  deviceId: () => ipcRenderer.invoke('device:id'),
  /** The slots of the updates kept by the app (src/boot/loader.js): write a file of one, empty one. */
  slots: {
    write: (slot, path, bytes) => ipcRenderer.invoke('slots:write', slot, path, bytes),
    remove: (slot) => ipcRenderer.invoke('slots:remove', slot),
  },
});
