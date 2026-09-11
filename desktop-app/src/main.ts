import { app, BrowserWindow, dialog, ipcMain, Menu, Tray } from 'electron';
import * as path from 'node:path';
import { ConfigManager } from './config-manager';

let mainWindow: BrowserWindow | undefined;
let manager: ConfigManager | undefined;
let tray: Tray | undefined;
let quitting = false;

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });

  app.whenReady().then(async () => {
    manager = new ConfigManager((channel, payload) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send(channel, payload);
    });
    registerIpc();
    createTray();
    createWindow();
    await manager.initialize();
    await sendState();
  }).catch((error) => {
    console.error('Fingerprint Proxy initialization failed', error);
    app.quit();
  });

  app.on('before-quit', (event) => {
    if (quitting) return;
    if (!manager) {
      quitting = true;
      return;
    }
    event.preventDefault();
    quitting = true;
    void manager.prepareForQuit().then(() => app.quit()).catch((error) => {
      quitting = false;
      console.error('Fingerprint Proxy could not stop Mihomo during quit', error);
      if (!mainWindow || mainWindow.isDestroyed()) createWindow();
      mainWindow?.show();
      mainWindow?.focus();
      dialog.showErrorBox('无法关闭 Fingerprint Proxy', `Mihomo 进程未能结束，软件将保持打开。\n\n${error instanceof Error ? error.message : String(error)}`);
    });
  });

  app.on('activate', () => {
    showMainWindow();
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1060,
    minHeight: 700,
    backgroundColor: '#0b1015',
    title: 'Fingerprint Proxy',
    icon: iconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  void mainWindow.loadFile(path.join(app.getAppPath(), 'src', 'renderer', 'index.html'));
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow?.hide();
  });
  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });
}

function createTray(): void {
  if (tray) return;
  tray = new Tray(iconPath());
  tray.setToolTip('Fingerprint Proxy');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示界面', click: () => showMainWindow() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
  tray.on('double-click', () => showMainWindow());
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function iconPath(): string {
  return path.join(app.getAppPath(), 'assets', 'icon.ico');
}

function getManager(): ConfigManager {
  if (!manager) throw new Error('应用尚未完成初始化。');
  return manager;
}

function registerIpc(): void {
  ipcMain.handle('state:get', () => getManager().getState());
  ipcMain.handle('sources:list', () => getManager().listSources());
  ipcMain.handle('sources:add', () => getManager().addSource());
  ipcMain.handle('sources:select', (_event, sourceId: string) => getManager().selectSource(sourceId));
  ipcMain.handle('sources:remove', (_event, sourceId: string) => getManager().removeSource(sourceId));
  ipcMain.handle('sources:refresh', (_event, args: { sourceId: string; startPort: number; protocol: 'socks5' | 'http' }) =>
    getManager().refresh(args.sourceId, { startPort: args.startPort, protocol: args.protocol }),
  );
  ipcMain.handle('settings:update', (_event, input: { startPort?: number; protocol?: 'socks5' | 'http' }) => getManager().updateSettings(input));
  ipcMain.handle('service:start', () => getManager().start());
  ipcMain.handle('service:stop', () => getManager().stop());
  ipcMain.handle('service:restart', () => getManager().restart());
  ipcMain.handle('service:status', () => getManager().getState().then((state) => state.service));
  ipcMain.handle('proxyImport:get', () => getManager().getImportText());
  ipcMain.handle('proxyImport:copy', () => getManager().copyImportText());
  ipcMain.handle('logs:clear', () => getManager().clearLogs());
}

async function sendState(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed() || !manager) return;
  mainWindow.webContents.send('state:changed', await manager.getState());
}
