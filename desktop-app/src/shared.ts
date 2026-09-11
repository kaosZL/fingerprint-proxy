export type LocalProtocol = 'socks5' | 'http';

export type ServiceState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export interface SourceRecord {
  id: string;
  path: string;
  snapshotPath: string;
  displayName: string;
  addedAt: string;
  lastKnownHash?: string;
  lastRefreshedAt?: string;
}

export interface SourceView extends SourceRecord {
  status: 'ok' | 'changed' | 'missing';
  isCurrent: boolean;
}

export interface AppSettings {
  sources: SourceRecord[];
  currentSourceId?: string;
  startPort: number;
  protocol: LocalProtocol;
}

export interface ServiceStatus {
  state: ServiceState;
  pid?: number;
  startedAt?: string;
  configPendingRestart: boolean;
  lastError?: string;
}

export interface NodeSummary {
  name: string;
  port: number;
}

export interface RefreshResult {
  ok: boolean;
  sourceId: string;
  nodeCount?: number;
  portStart?: number;
  portEnd?: number;
  importText?: string;
  warnings?: string[];
  error?: string;
  pendingRestart?: boolean;
}

export interface ActiveGeneration {
  sourceId: string;
  sourceHash: string;
  configHash: string;
  importHash: string;
  startPort: number;
  protocol: LocalProtocol;
  generatedAt: string;
}

export interface AppState {
  settings: AppSettings;
  sources: SourceView[];
  service: ServiceStatus;
  importText: string;
  mixedPort: number;
  logs: string[];
  activeGeneration?: ActiveGeneration;
  configNeedsRefresh: boolean;
}
