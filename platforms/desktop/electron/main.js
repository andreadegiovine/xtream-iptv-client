/*
 * Electron main process of the desktop app: one window showing the built app (dist/, served as app://xtream/ so that workers and
 * IndexedDB have a normal origin) in a normal, resizable window (the player has a button for full screen, F11 does the same), with the
 * 1920x1080 interface scaled to the window.
 *
 * Network: the Xtream servers send no CORS headers and are often plain http, so the page runs with webSecurity off (no CORS, no mixed
 * content block), as a TV app does. The page only ever comes from the app's own files: navigation elsewhere is blocked and window.open
 * (trailers, links) goes to the system browser.
 */
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { app, BrowserWindow, protocol, net, shell, screen, ipcMain, powerSaveBlocker } = require('electron');

const SCHEME = 'app';
const ORIGIN = `${SCHEME}://xtream`;
// Packaged: the build sits next to this file (app/); from the repository: dist/.
const ROOT = app.isPackaged ? path.join(__dirname, 'app') : path.resolve(__dirname, '..', '..', '..', 'dist');
const DESIGN = { width: 1920, height: 1080 };

protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

// The updates kept by the app (src/boot/loader.js): two slots of files in the user's data folder, served at app://xtream/__slot/<slot>/.
const SLOTS = () => path.join(app.getPath('userData'), 'slots');
const SLOT_NAME = /^[ab]$/;
const SLOT_FILE = /^(slot\.json|(js|css|fonts)\/[\w.-]+)$/;

/** A file under `root` (never outside it), or null. */
function inside(root, relative) {
  const file = path.normalize(path.join(root, relative));
  return file === root || file.startsWith(root + path.sep) ? file : null;
}

/** app://xtream/<path> → the file under ROOT; app://xtream/__slot/<slot>/<path> → the file of that slot. */
function serveFile(request) {
  const pathname = decodeURIComponent(new URL(request.url).pathname);
  const slot = /^\/__slot\/([ab])\/(.+)$/.exec(pathname);
  const file = slot ? inside(path.join(SLOTS(), slot[1]), slot[2]) : inside(ROOT, pathname === '/' ? '/index.html' : pathname);
  if (!file || (slot && !fs.existsSync(file))) return new Response('Not found', { status: 404 });
  return net.fetch(pathToFileURL(file).toString());
}

// The page writes the files of an update into a slot and empties a slot (preload.js); only the names the loader uses.
ipcMain.handle('slots:write', async (event, slot, relative, bytes) => {
  if (!SLOT_NAME.test(slot) || !SLOT_FILE.test(relative)) throw new Error('invalid slot file');
  const file = inside(path.join(SLOTS(), slot), relative);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, Buffer.from(bytes));
  return true;
});
ipcMain.handle('slots:remove', async (event, slot) => {
  if (!SLOT_NAME.test(slot)) throw new Error('invalid slot');
  await fs.promises.rm(path.join(SLOTS(), slot), { recursive: true, force: true });
  return true;
});

function createWindow() {
  // A 16:9 window, 1280x720 at most as large as 85% of the work area (the interface scales with it).
  const area = screen.getPrimaryDisplay().workAreaSize;
  const scale = Math.min(1, (area.width * 0.85) / 1280, (area.height * 0.85) / 720);
  const win = new BrowserWindow({
    width: Math.round(1280 * scale),
    height: Math.round(720 * scale),
    minWidth: 640,
    minHeight: 360,
    useContentSize: true,
    center: true,
    backgroundColor: '#0c0c12',
    autoHideMenuBar: true,
    icon: path.join(ROOT, 'icon.png'),
    // AudioVideoTracks: `video.audioTracks` (off by default in Chromium), so the player lists the audio tracks of a file and switches them.
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: false, enableBlinkFeatures: 'AudioVideoTracks' },
  });
  win.removeMenu();
  // The interface is drawn for 1920x1080: the zoom makes it fit the window (and the screen in full screen).
  const fit = () => {
    const [width, height] = win.getContentSize();
    win.webContents.setZoomFactor(Math.max(0.25, Math.min(width / DESIGN.width, height / DESIGN.height)));
  };
  win.on('resize', fit);
  win.on('resized', fit);
  win.on('enter-full-screen', fit);
  win.on('leave-full-screen', fit);
  win.webContents.on('did-finish-load', fit);
  // F11 switches full screen; F12 opens the developer tools.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    } else if (input.key === 'F12') {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${ORIGIN}/`)) event.preventDefault();
  });
  // While a video plays the display does not go to sleep (nor the screensaver of the system start); paused or closed: it may again.
  let blocker = null;
  const awake = (on) => {
    if (on && blocker === null) blocker = powerSaveBlocker.start('prevent-display-sleep');
    else if (!on && blocker !== null) {
      powerSaveBlocker.stop(blocker);
      blocker = null;
    }
  };
  win.webContents.on('media-started-playing', () => awake(true));
  win.webContents.on('media-paused', () => awake(false));
  win.on('closed', () => awake(false));
  win.loadURL(`${ORIGIN}/index.html`);
}

// The player's full-screen button (preload.js): switches the window of the caller, or just reports its state.
ipcMain.handle('window:fullscreen', (event, toggle) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  if (toggle) win.setFullScreen(!win.isFullScreen());
  return win.isFullScreen();
});

// A scheduled viewing notification was clicked (preload.js): the window comes to the front.
ipcMain.handle('window:show', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return true;
});

// Windows shows the notifications of an app only under its AppUserModelID: the one of the installer's Start menu shortcut (electron-builder
// uses the appId of electron-builder.json).
if (process.platform === 'win32') app.setAppUserModelId('com.xtrmiptv.desktop');

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    protocol.handle(SCHEME, serveFile);
    createWindow();
    app.on('activate', () => {
      if (!BrowserWindow.getAllWindows().length) createWindow();
    });
  });
  app.on('window-all-closed', () => app.quit());
}
