import { app, BrowserWindow, Menu, nativeTheme, shell } from 'electron';
import path from 'node:path';
import { registerIpc } from './ipc';
import { startMcpServer } from './mcp/server';
import { getSettings } from './store';
import { disconnectAll } from './kafka/pool';
import * as terminal from './terminal/manager';
import { stopAllConsumers } from './kafka/messages';

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

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? ([{ role: 'appMenu' }] as Electron.MenuItemConstructorOptions[]) : []),
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
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  if (MCP_MODE) {
    process.env.EREBUS_VERSION = app.getVersion();
    app.dock?.hide();
    startMcpServer();
    return;
  }

  const settings = getSettings();
  nativeTheme.themeSource = settings.theme;
  registerIpc();
  buildMenu();
  createWindow();
  startAutoTerminals();

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

app.on('before-quit', async (event) => {
  if (shuttingDown) return;
  shuttingDown = true;
  event.preventDefault();
  stopAllConsumers();
  terminal.killAll();
  await disconnectAll();
  app.quit();
});

if (isDev) {
  process.on('unhandledRejection', (reason) => console.error('[erebus] unhandled rejection', reason));
}
