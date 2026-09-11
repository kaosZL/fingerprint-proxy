import { contextBridge, ipcRenderer } from 'electron';

type StateHandler = (state: unknown) => void;
type LogHandler = (line: unknown) => void;

function subscribe(channel: string, handler: (payload: unknown) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('fingerprintProxy', {
  state: {
    get: () => ipcRenderer.invoke('state:get'),
  },
  sources: {
    list: () => ipcRenderer.invoke('sources:list'),
    add: () => ipcRenderer.invoke('sources:add'),
    select: (sourceId: string) => ipcRenderer.invoke('sources:select', sourceId),
    remove: (sourceId: string) => ipcRenderer.invoke('sources:remove', sourceId),
    refresh: (args: { sourceId: string; startPort: number; protocol: 'socks5' | 'http' }) => ipcRenderer.invoke('sources:refresh', args),
  },
  settings: {
    update: (input: { startPort?: number; protocol?: 'socks5' | 'http' }) => ipcRenderer.invoke('settings:update', input),
  },
  service: {
    start: () => ipcRenderer.invoke('service:start'),
    stop: () => ipcRenderer.invoke('service:stop'),
    restart: () => ipcRenderer.invoke('service:restart'),
    status: () => ipcRenderer.invoke('service:status'),
  },
  proxyImport: {
    get: () => ipcRenderer.invoke('proxyImport:get'),
    copy: () => ipcRenderer.invoke('proxyImport:copy'),
  },
  logs: {
    clear: () => ipcRenderer.invoke('logs:clear'),
  },
  onStateChanged: (handler: StateHandler) => subscribe('state:changed', handler),
  onLog: (handler: LogHandler) => subscribe('logs:line', handler),
});
