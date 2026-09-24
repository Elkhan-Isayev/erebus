import { app, BrowserWindow, dialog, Menu, nativeTheme, shell } from 'electron';
import path from 'node:path';
import { registerIpc } from './ipc';
import { startMcpServer } from './mcp/server';
import { getSettings, updateSettings } from './store';
import { disconnectAll } from './kafka/pool';
import * as terminal from './terminal/manager';
import { stopAllConsumers } from './kafka/messages';
import { checkForUpdates, startUpdateChecks } from './updater';
import { shutdown } from './shutdown';

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const isDev = Boolean(DEV_SERVER_URL);
/** `--mcp` turns the app into a headless MCP server on stdio. */
const MCP_MODE = process.argv.includes('--mcp');
let shuttingDown = false;

// An MCP server is a child process of the agent — it must never steal the GUI instance lock.
if (!MCP_MODE && !app.requestSingleInstanceLock()) {
  app.quit();
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e1017' : '#f6f7fb',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 14, y: 18 } : undefined,
    icon: process.platform === 'linux' ? path.join(__dirname, '../build/icon.png') : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (DEV_SERVER_URL) {
    const load = (attempt = 0) => {
      win.loadURL(DEV_SERVER_URL).catch(() => {
        if (attempt < 60) setTimeout(() => load(attempt + 1), 400);
      });
    };
    load();
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  return win;
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const send = (channel: string) => () => BrowserWindow.getFocusedWindow()?.webContents.send(`erebus:${channel}`);
  const checkUpdates: Electron.MenuItemConstructorOptions = {
    label: 'Check for Updates…',
    click: () => {
      const [win] = BrowserWindow.getAllWindows();
      win?.webContents.send('erebus:menu:check-updates');
      void checkForUpdates();
    },
  };

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            role: 'appMenu',
            submenu: [
              { role: 'about' },
              checkUpdates,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ] as Electron.MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Cluster…', accelerator: 'CmdOrCtrl+N', click: send('menu:new-cluster') },
        { type: 'separator' },
        { label: 'Refresh', accelerator: 'CmdOrCtrl+R', click: send('menu:refresh') },
        { label: 'New Terminal Tab', accelerator: 'CmdOrCtrl+T', click: send('menu:new-terminal') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Theme', accelerator: 'CmdOrCtrl+Shift+L', click: send('menu:toggle-theme') },
        { label: 'Command Palette', accelerator: 'CmdOrCtrl+K', click: send('menu:palette') },
        { label: 'Toggle Terminal', accelerator: 'CmdOrCtrl+`', click: send('menu:toggle-terminal') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Erebus on GitHub',
          click: () => shell.openExternal('https://github.com/Elkhan-Isayev/erebus'),
        },
        {
          label: 'Report an Issue',
          click: () => shell.openExternal('https://github.com/Elkhan-Isayev/erebus/issues/new'),
        },
        ...(isMac ? [] : ([{ type: 'separator' }, checkUpdates] as Electron.MenuItemConstructorOptions[])),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * A Mac app run straight from the disk image or Downloads never lands in Applications, and
 * the updater cannot replace a bundle on a read-only image. Offer the move, the way most
 * Mac apps do; Electron moves the bundle, handles App Translocation and relaunches.
 * Resolves true when the app is about to relaunch from its new home.
 */
async function offerMoveToApplications(): Promise<boolean> {
  if (process.platform !== 'darwin' || !app.isPackaged || app.isInApplicationsFolder()) return false;
  if (getSettings().askToMoveToApplications === false) return false;

  const { response, checkboxChecked } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Move to Applications', 'Not Now'],
    defaultId: 0,
    cancelId: 1,
    message: 'Move Erebus to the Applications folder?',
    detail: 'Erebus is running from outside Applications. Moving it there keeps it in Launchpad and lets it update itself.',
    checkboxLabel: "Don't ask again",
  });
  if (response !== 0) {
    if (checkboxChecked) updateSettings({ askToMoveToApplications: false });
    return false;
  }
  try {
    return app.moveToApplicationsFolder();
  } catch (err) {
    dialog.showErrorBox('Could not move Erebus', (err as Error).message);
    return false;
  }
}

app.whenReady().then(async () => {
  if (MCP_MODE) {
    process.env.EREBUS_VERSION = app.getVersion();
    app.dock?.hide();
    startMcpServer();
    return;
  }

  if (await offerMoveToApplications()) return;

  const settings = getSettings();
  nativeTheme.themeSource = settings.theme;
  registerIpc();
  buildMenu();
  createWindow();
  startAutoTerminals();
  startUpdateChecks();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/** Port-forwards and other saved commands that should be up before you touch anything. */
function startAutoTerminals(): void {
  for (const profile of getSettings().terminals ?? []) {
    if (!profile.autoStart) continue;
    try {
      const session = terminal.createSession({ name: profile.name, cwd: profile.cwd, profileId: profile.id });
      terminal.run(session.id, profile.command);
    } catch (err) {
      console.error(`[erebus] could not auto-start ${profile.name}:`, err);
    }
  }
}

app.on('second-instance', () => {
  const [win] = BrowserWindow.getAllWindows();
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('window-all-closed', () => {
  if (!MCP_MODE && process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (shuttingDown) return;
  shuttingDown = true;
  event.preventDefault();
  // app.exit(), unlike app.quit(), cannot be vetoed by anything still holding on.
  void shutdown({
    stopConsumers: stopAllConsumers,
    disconnect: disconnectAll,
    killTerminals: terminal.killAll,
    exit: () => app.exit(0),
  });
});

if (isDev) {
  process.on('unhandledRejection', (reason) => console.error('[erebus] unhandled rejection', reason));
}
