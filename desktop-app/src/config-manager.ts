import { app, clipboard, dialog } from 'electron';
import { ChildProcessByStdio, execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile, copyFile } from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import YAML from 'yaml';
import { buildGeneratedConfig } from './config-generator';
import { assertLocalPortsAvailable, collectUdpListenerPorts } from './port-availability';
import {
  AppSettings,
  AppState,
  ActiveGeneration,
  LocalProtocol,
  RefreshResult,
  ServiceStatus,
  SourceRecord,
  SourceView,
} from './shared';

interface ManagerEventSink {
  (channel: 'state:changed' | 'logs:line', payload: unknown): void;
}

interface ValidationResult {
  ok: boolean;
  output: string;
}

interface RefreshOptions {
  startPort: number;
  protocol: LocalProtocol;
}

const MAX_LOG_LINES = 600;
const VALIDATION_TIMEOUT_MS = 30_000;
const TOP_LEVEL_PORT_KEYS = ['port', 'mixed-port', 'socks-port', 'redir-port', 'tproxy-port'] as const;
const DEFAULT_SETTINGS: AppSettings = {
  sources: [],
  startPort: 20001,
  protocol: 'socks5',
};

function normalizePath(value: string): string {
  return path.resolve(value).toLowerCase();
}

function isYamlPath(value: string): boolean {
  return /\.(yaml|yml)$/i.test(value);
}

function safeInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function assertStartPort(value: number): void {
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error('指纹代理起始端口必须是 1024-65535 之间的整数。');
  }
}

function formatLogLine(message: string): string {
  const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  return `[${stamp}] ${message}`;
}

type ManagedProcess = ChildProcessByStdio<null, Readable, Readable>;

function hasProcess(processRef: ManagedProcess | undefined): boolean {
  // `killed` only means that a signal was sent; the process can still be alive
  // until its close event arrives.
  return Boolean(processRef && processRef.exitCode === null);
}

export class ConfigManager {
  private readonly userDir: string;
  private readonly sourceDir: string;
  private readonly snapshotsDir: string;
  private readonly runtimeDir: string;
  private readonly activeDir: string;
  private readonly settingsPath: string;
  private readonly appRoot: string;
  private settings: AppSettings = structuredClone(DEFAULT_SETTINGS);
  private managedProcess?: ManagedProcess;
  private readonly validationProcesses = new Set<ManagedProcess>();
  private readonly validationStopPromises = new Map<ManagedProcess, Promise<boolean>>();
  private stoppingPromise?: Promise<void>;
  private operationTail: Promise<void> = Promise.resolve();
  private service: ServiceStatus = {
    state: 'stopped',
    configPendingRestart: false,
  };
  private logs: string[] = [];
  private sourceCheckTimer?: NodeJS.Timeout;
  private sourceStatusSignature = '';
  private closed = false;

  constructor(private readonly emit: ManagerEventSink) {
    this.userDir = path.join(process.env.APPDATA || path.dirname(process.execPath), 'FingerprintProxy');
    this.sourceDir = path.join(this.userDir, 'sources');
    this.snapshotsDir = path.join(this.sourceDir, 'snapshots');
    this.runtimeDir = path.join(process.env.LOCALAPPDATA || this.userDir, 'FingerprintProxy', 'runtime');
    this.activeDir = path.join(this.runtimeDir, 'active');
    this.settingsPath = path.join(this.userDir, 'settings.json');
    this.appRoot = path.resolve(__dirname, '../..');
  }

  async initialize(): Promise<void> {
    await mkdir(this.snapshotsDir, { recursive: true });
    await mkdir(this.activeDir, { recursive: true });
    await this.loadSettings();
    await this.seedDevelopmentSources();
    await this.ensureBundledGeoIp();
    this.startSourceMonitor();
    this.appendLog('Fingerprint Proxy 已就绪。');

    if (!(await this.isActiveBundleComplete(await this.readActiveGeneration()))) {
      const current = this.settings.currentSourceId;
      if (current) {
        const result = await this.refresh(current, {
          startPort: this.settings.startPort,
          protocol: this.settings.protocol,
        }, true);
        if (!result.ok) this.appendLog('首次生成运行配置失败，请选择配置源后手动刷新。');
      }
    }
  }

  dispose(): void {
    this.closed = true;
    if (this.sourceCheckTimer) clearInterval(this.sourceCheckTimer);
  }

  get sourceSnapshotDirectory(): string {
    return this.snapshotsDir;
  }

  async getState(): Promise<AppState> {
    const [sources, importText, mixedPort, activeGeneration] = await Promise.all([
      this.getSourceViews(),
      this.readImportText(),
      this.readMixedPort(),
      this.readActiveGeneration(),
    ]);
    const bundleComplete = await this.isActiveBundleComplete(activeGeneration);
    const configNeedsRefresh = (!bundleComplete || !this.isGenerationCurrent(activeGeneration))
      && Boolean(this.settings.currentSourceId || importText || activeGeneration);
    return {
      settings: structuredClone(this.settings),
      sources,
      service: structuredClone(this.service),
      importText: configNeedsRefresh ? '' : importText,
      mixedPort,
      logs: [...this.logs],
      activeGeneration,
      configNeedsRefresh,
    };
  }

  async listSources(): Promise<SourceView[]> {
    return this.getSourceViews();
  }

  async addSource(): Promise<{ ok: boolean; cancelled?: boolean; source?: SourceView; error?: string }> {
    const result = await dialog.showOpenDialog({
      title: '选择 YAML 配置',
      properties: ['openFile'],
      filters: [{ name: 'Clash / Mihomo YAML', extensions: ['yaml', 'yml'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false, cancelled: true };
    return this.enqueueOperation(async () => {
      try {
        const source = await this.addSourceFromPath(result.filePaths[0]);
        await this.emitState();
        return { ok: true, source: await this.toSourceView(source) };
      } catch (error) {
        const message = this.errorMessage(error);
        this.appendLog(`导入失败：${message}`);
        return { ok: false, error: message };
      }
    });
  }

  selectSource(sourceId: string): Promise<AppState> {
    return this.enqueueOperation(() => this.selectSourceInternal(sourceId));
  }

  private async selectSourceInternal(sourceId: string): Promise<AppState> {
    const nextSettings = structuredClone(this.settings);
    const source = nextSettings.sources.find((item) => item.id === sourceId);
    if (!source) throw new Error('找不到指定的配置源。');
    nextSettings.currentSourceId = source.id;
    await this.saveSettings(nextSettings);
    this.settings = nextSettings;
    await this.emitState();
    return this.getState();
  }

  removeSource(sourceId: string): Promise<AppState> {
    return this.enqueueOperation(() => this.removeSourceInternal(sourceId));
  }

  private async removeSourceInternal(sourceId: string): Promise<AppState> {
    const nextSettings = structuredClone(this.settings);
    const index = nextSettings.sources.findIndex((item) => item.id === sourceId);
    if (index < 0) throw new Error('找不到指定的配置源。');
    const [removed] = nextSettings.sources.splice(index, 1);
    if (nextSettings.currentSourceId === sourceId) {
      nextSettings.currentSourceId = nextSettings.sources[0]?.id;
    }
    await this.saveSettings(nextSettings);
    this.settings = nextSettings;
    try {
      await rm(removed.snapshotPath, { force: true });
    } catch (error) {
      this.appendLog(`配置源已移除，但旧快照清理失败：${this.errorMessage(error)}`);
    }
    this.appendLog(`已移除配置源：${removed.displayName}`);
    await this.emitState();
    return this.getState();
  }

  updateSettings(input: Partial<Pick<AppSettings, 'startPort' | 'protocol'>>): Promise<AppSettings> {
    return this.enqueueOperation(() => this.updateSettingsInternal(input));
  }

  private async updateSettingsInternal(input: Partial<Pick<AppSettings, 'startPort' | 'protocol'>>): Promise<AppSettings> {
    const nextSettings = structuredClone(this.settings);
    if (input.startPort !== undefined) {
      const startPort = safeInteger(input.startPort, Number.NaN);
      assertStartPort(startPort);
      nextSettings.startPort = startPort;
    }
    if (input.protocol === 'socks5' || input.protocol === 'http') nextSettings.protocol = input.protocol;
    await this.saveSettings(nextSettings);
    this.settings = nextSettings;
    await this.emitState();
    return structuredClone(this.settings);
  }

  refresh(sourceId: string, options: RefreshOptions, silent = false): Promise<RefreshResult> {
    return this.enqueueOperation(() => this.refreshInternal(sourceId, options, silent));
  }

  private async refreshInternal(sourceId: string, options: RefreshOptions, silent = false): Promise<RefreshResult> {
    if (this.closed) return { ok: false, sourceId, error: '应用正在关闭，暂不刷新配置。' };
    const source = this.settings.sources.find((item) => item.id === sourceId);
    if (!source) return { ok: false, sourceId, error: '找不到指定的配置源。' };

    const startPort = safeInteger(options.startPort, this.settings.startPort);
    const protocol: LocalProtocol = options.protocol === 'http' ? 'http' : 'socks5';
    try {
      assertStartPort(startPort);
    } catch (error) {
      const message = this.errorMessage(error);
      this.appendLog(`刷新失败：${message}`);
      return { ok: false, sourceId, error: message };
    }
    const requestedSettings = structuredClone(this.settings);
    requestedSettings.startPort = startPort;
    requestedSettings.protocol = protocol;
    requestedSettings.currentSourceId = sourceId;
    await this.saveSettings(requestedSettings);
    this.settings = requestedSettings;

    let stageDir = '';
    try {
      const { sourcePath, raw } = await this.readSourceWithFallback(source);
      const sourceHash = createHash('sha256').update(raw, 'utf8').digest('hex');
      const parsed = YAML.parse(raw);
      this.assertNoRelativeProviderPaths(parsed, sourcePath);
      const reservedPorts = this.collectReservedPorts(parsed, startPort);
      const managedProcessRunning = hasProcess(this.managedProcess);
      const activePorts = managedProcessRunning ? await this.readActiveConfigPorts() : new Set<number>();
      const activeUdpPorts = managedProcessRunning ? await this.readActiveConfigUdpPorts() : new Set<number>();
      if (managedProcessRunning) {
        for (const port of activePorts) reservedPorts.add(port);
      }
      const controllerPort = await this.findFreePort(reservedPorts);
      const generated = buildGeneratedConfig(parsed, {
        startPort,
        protocol,
        controllerAddress: `127.0.0.1:${controllerPort}`,
        secret: randomBytes(24).toString('hex'),
        maxNodes: 500,
      });

      await this.assertGeneratedPortsAvailable(
        this.collectRuntimePorts(generated.config),
        collectUdpListenerPorts(generated.config),
        activePorts,
        activeUdpPorts,
      );

      stageDir = path.join(this.runtimeDir, `staging-${randomUUID()}`);
      await mkdir(stageDir, { recursive: true });
      await writeFile(path.join(stageDir, 'config.yaml'), generated.yamlText, 'utf8');
      await writeFile(path.join(stageDir, 'proxy-import.txt'), generated.importText, 'utf8');
      await writeFile(path.join(stageDir, 'source-snapshot.yaml'), raw, 'utf8');
      const generatedAt = new Date().toISOString();
      const activeGeneration: ActiveGeneration = {
        sourceId,
        sourceHash,
        configHash: createHash('sha256').update(generated.yamlText, 'utf8').digest('hex'),
        importHash: createHash('sha256').update(generated.importText, 'utf8').digest('hex'),
        startPort,
        protocol,
        generatedAt,
      };
      const nextSettings = structuredClone(this.settings);
      const nextSource = nextSettings.sources.find((item) => item.id === sourceId);
      if (!nextSource) throw new Error('配置源在刷新过程中被移除。');
      nextSource.lastKnownHash = sourceHash;
      nextSource.lastRefreshedAt = generatedAt;
      nextSettings.currentSourceId = sourceId;
      await writeFile(path.join(stageDir, 'generation.json'), JSON.stringify(activeGeneration, null, 2), 'utf8');
      await writeFile(path.join(stageDir, 'settings.json'), JSON.stringify(nextSettings, null, 2), 'utf8');
      // Keep a fresh GeoIP copy in staging for validation. The installer below
      // only replaces the active copy when one does not already exist, so a
      // running Mihomo process never loses its file handle during refresh.
      await this.copyBundledGeoIp(stageDir);

      if (this.closed) throw new Error('应用正在关闭，暂不刷新配置。');
      const validation = await this.validateConfig(stageDir, path.join(stageDir, 'config.yaml'));
      if (!validation.ok) {
        throw new Error(`Mihomo 配置校验失败：${this.cleanValidationOutput(validation.output)}`);
      }

      const installGeoIp = !(await this.fileExists(path.join(this.activeDir, 'geoip.metadb')));
      await this.installGeneratedFiles(stageDir, source.snapshotPath, installGeoIp);
      this.settings = nextSettings;
      this.service.configPendingRestart = hasProcess(this.managedProcess);

      const warningText = generated.warnings.join(' ');
      this.appendLog(`配置已刷新：${source.displayName}，生成 ${generated.nodes.length} 个本地入口。`);
      if (warningText) this.appendLog(warningText);
      if (this.service.configPendingRestart) this.appendLog('代理仍在运行，新配置将在手动重启后生效。');
      await this.emitState();
      return {
        ok: true,
        sourceId,
        nodeCount: generated.nodes.length,
        portStart: generated.nodes[0]?.port,
        portEnd: generated.nodes.at(-1)?.port,
        importText: generated.importText,
        warnings: generated.warnings,
        pendingRestart: this.service.configPendingRestart,
      };
    } catch (error) {
      const message = this.errorMessage(error);
      this.appendLog(`刷新失败：${message}`);
      await this.emitState();
      return { ok: false, sourceId, error: message };
    } finally {
      if (stageDir) await rm(stageDir, { recursive: true, force: true });
    }
  }

  start(): Promise<ServiceStatus> {
    return this.enqueueOperation(() => this.startInternal());
  }

  private async startInternal(): Promise<ServiceStatus> {
    if (this.closed) return structuredClone(this.service);
    if (this.stoppingPromise) await this.stoppingPromise;
    if (hasProcess(this.managedProcess)) return structuredClone(this.service);
    if (this.managedProcess && this.managedProcess.exitCode !== null) this.managedProcess = undefined;
    const configPath = this.activeConfigPath();
    const activeGeneration = await this.readActiveGeneration();
    if (!(await this.isActiveBundleComplete(activeGeneration))) {
      this.service = { state: 'error', configPendingRestart: false, lastError: '运行配置文件不完整或已被修改，请重新刷新 YAML。' };
      this.appendLog(this.service.lastError ?? '运行配置文件不完整或已被修改，请重新刷新 YAML。');
      await this.emitState();
      return structuredClone(this.service);
    }
    if (!this.isGenerationCurrent(activeGeneration)) {
      const lastError = '当前配置源或端口设置尚未刷新，请先点击“刷新配置”。';
      this.service = { state: 'error', configPendingRestart: false, lastError };
      this.appendLog(lastError);
      await this.emitState();
      return structuredClone(this.service);
    }
    const binary = this.mihomoPath();
    if (!binary || !(await this.fileExists(binary))) {
      this.service = { state: 'error', configPendingRestart: false, lastError: '安装包中找不到 Mihomo 核心文件。' };
      this.appendLog(this.service.lastError ?? '安装包中找不到 Mihomo 核心文件。');
      await this.emitState();
      return structuredClone(this.service);
    }

    this.service = { state: 'starting', configPendingRestart: false };
    await this.emitState();
    this.appendLog('正在启动代理服务…');
    const child = spawn(binary, ['-d', this.activeDir, '-f', configPath], {
      cwd: this.activeDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.managedProcess = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.appendMihomoOutput(chunk));
    child.stderr.on('data', (chunk: string) => this.appendMihomoOutput(chunk));
    child.once('spawn', () => {
      if (this.managedProcess !== child) return;
      this.service = { state: 'running', pid: child.pid, startedAt: new Date().toISOString(), configPendingRestart: false };
      this.appendLog(`代理服务运行中（PID ${child.pid ?? '未知'}）。`);
      void this.emitState();
    });
    child.once('error', (error) => {
      if (this.managedProcess !== child) return;
      this.service = { state: 'error', configPendingRestart: false, lastError: this.errorMessage(error) };
      this.appendLog(`代理进程启动失败：${this.service.lastError}`);
      void this.emitState();
    });
    child.once('close', (code, signal) => {
      if (this.managedProcess !== child) return;
      const wasStopping = this.service.state === 'stopping';
      this.managedProcess = undefined;
      this.service = wasStopping
        ? { state: 'stopped', configPendingRestart: false }
        : code === 0
          ? { state: 'stopped', configPendingRestart: false }
          : { state: 'error', configPendingRestart: false, lastError: `Mihomo 已退出（code=${code ?? 'null'}, signal=${signal ?? 'none'}）。` };
      if (!wasStopping && code !== 0) this.appendLog(this.service.lastError ?? 'Mihomo 已退出。');
      else if (wasStopping) this.appendLog('代理服务已停止。');
      void this.emitState();
    });
    return structuredClone(this.service);
  }

  stop(): Promise<ServiceStatus> {
    return this.enqueueOperation(() => this.stopInternal());
  }

  private async stopInternal(): Promise<ServiceStatus> {
    if (this.stoppingPromise) {
      await this.stoppingPromise;
      return structuredClone(this.service);
    }
    const child = this.managedProcess;
    if (!child || child.exitCode !== null) {
      if (this.managedProcess === child) this.managedProcess = undefined;
      this.service = { state: 'stopped', configPendingRestart: false };
      await this.emitState();
      return structuredClone(this.service);
    }
    this.service = { ...this.service, state: 'stopping' };
    this.appendLog('正在停止代理服务…');
    const stopPromise = new Promise<void>((resolve, reject) => {
      let finished = false;
      let forceTimer: NodeJS.Timeout | undefined;
      let verificationTimer: NodeJS.Timeout | undefined;
      const clearTimers = () => {
        if (forceTimer) clearTimeout(forceTimer);
        if (verificationTimer) clearTimeout(verificationTimer);
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimers();
        if (this.managedProcess === child) {
          this.managedProcess = undefined;
          this.service = { state: 'stopped', configPendingRestart: false };
        }
        resolve();
      };
      const fail = (message: string) => {
        if (finished) return;
        finished = true;
        clearTimers();
        this.service = { ...this.service, state: 'error', lastError: message };
        this.appendLog(message);
        reject(new Error(message));
      };
      const verifyStopped = () => {
        if (finished) return;
        if (!this.isChildAlive(child)) finish();
        else fail('无法停止 Mihomo 进程，进程仍在运行。请重试或在任务管理器中结束该进程。');
      };
      const forceStop = () => {
        if (finished) return;
        if (!this.isChildAlive(child)) {
          finish();
          return;
        }
        if (process.platform === 'win32' && child.pid) {
          execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], (error) => {
            if (finished) return;
            if (error && this.isChildAlive(child)) {
              fail(`强制停止 Mihomo 失败：${this.errorMessage(error)}`);
              return;
            }
            verificationTimer = setTimeout(verifyStopped, 1500);
            verificationTimer.unref();
          });
        } else {
          try {
            child.kill('SIGKILL');
          } catch (error) {
            if (this.isChildAlive(child)) {
              fail(`强制停止 Mihomo 失败：${this.errorMessage(error)}`);
              return;
            }
          }
          verificationTimer = setTimeout(verifyStopped, 1500);
          verificationTimer.unref();
        }
      };
      child.once('close', finish);
      try {
        if (!child.kill()) forceStop();
      } catch {
        forceStop();
      }
      if (!finished) {
        forceTimer = setTimeout(forceStop, 4500);
        forceTimer.unref();
      }
    });
    this.stoppingPromise = stopPromise;
    // Publish the stopping state only after the shared promise is installed so
    // concurrent start/stop/restart calls cannot slip through this transition.
    await this.emitState();
    try {
      await stopPromise;
    } finally {
      if (this.stoppingPromise === stopPromise) this.stoppingPromise = undefined;
    }
    return structuredClone(this.service);
  }

  restart(): Promise<ServiceStatus> {
    return this.enqueueOperation(async () => {
      const activeGeneration = await this.readActiveGeneration();
      if (!this.isGenerationCurrent(activeGeneration) || !(await this.isActiveBundleComplete(activeGeneration))) {
        throw new Error('当前配置源或端口设置尚未刷新，请先点击“刷新配置”，代理保持原状态。');
      }
      await this.stopInternal();
      return this.startInternal();
    });
  }

  async prepareForQuit(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.sourceCheckTimer) clearInterval(this.sourceCheckTimer);
    this.sourceCheckTimer = undefined;
    try {
      await this.terminateValidationProcesses();
      await this.enqueueOperation(async () => {
        await this.terminateValidationProcesses();
        if (this.stoppingPromise) await this.stoppingPromise;
        if (this.managedProcess && this.managedProcess.exitCode === null) await this.stopInternal();
      });
    } catch (error) {
      this.closed = false;
      this.startSourceMonitor();
      throw error;
    }
  }

  async getImportText(): Promise<string> {
    const generation = await this.readActiveGeneration();
    return this.isGenerationCurrent(generation) && await this.isActiveBundleComplete(generation) ? this.readImportText() : '';
  }

  async copyImportText(): Promise<{ ok: boolean; length: number }> {
    const generation = await this.readActiveGeneration();
    if (!this.isGenerationCurrent(generation) || !(await this.isActiveBundleComplete(generation))) {
      throw new Error('当前配置源或端口设置尚未刷新，不能复制旧的导入内容。');
    }
    const text = await this.readImportText();
    clipboard.writeText(text);
    this.appendLog(`已复制 proxy-import.txt（${text.length} 个字符）。`);
    return { ok: true, length: text.length };
  }

  clearLogs(): void {
    this.logs = [];
    this.emit('logs:line', { clear: true });
    void this.emitState();
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async loadSettings(): Promise<void> {
    try {
      const raw = await readFile(this.settingsPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      const sources = Array.isArray(parsed.sources) ? parsed.sources.filter((source) => this.isSourceRecord(source)) : [];
      this.settings = {
        sources,
        currentSourceId: typeof parsed.currentSourceId === 'string' ? parsed.currentSourceId : undefined,
        startPort: safeInteger(parsed.startPort, DEFAULT_SETTINGS.startPort),
        protocol: parsed.protocol === 'http' ? 'http' : 'socks5',
      };
      if (!this.settings.sources.some((source) => source.id === this.settings.currentSourceId)) {
        this.settings.currentSourceId = this.settings.sources[0]?.id;
      }
    } catch {
      this.settings = structuredClone(DEFAULT_SETTINGS);
    }
  }

  private async saveSettings(settings = this.settings): Promise<void> {
    await mkdir(this.userDir, { recursive: true });
    const tempPath = `${this.settingsPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, JSON.stringify(settings, null, 2), 'utf8');
      await rename(tempPath, this.settingsPath);
    } finally {
      await rm(tempPath, { force: true });
    }
  }

  private async seedDevelopmentSources(): Promise<void> {
    if (this.settings.sources.length > 0 || app.isPackaged) return;
    try {
      const entries = await readdir(this.appRoot, { withFileTypes: true });
      const yamlFiles = entries
        .filter((entry) => entry.isFile() && isYamlPath(entry.name))
        .map((entry) => path.join(this.appRoot, entry.name))
        .sort((a, b) => a.localeCompare(b, 'zh-CN'));
      for (const filePath of yamlFiles) await this.addSourceFromPath(filePath, false);
      if (this.settings.sources.length > 0) {
        this.settings.currentSourceId = this.settings.sources[0].id;
        await this.saveSettings();
        this.appendLog(`已发现 ${this.settings.sources.length} 个本地 YAML 配置源。`);
      }
    } catch (error) {
      this.appendLog(`扫描本地 YAML 失败：${this.errorMessage(error)}`);
    }
  }

  private async addSourceFromPath(filePath: string, select = true): Promise<SourceRecord> {
    const resolvedPath = path.resolve(filePath);
    if (!isYamlPath(resolvedPath)) throw new Error('请选择 .yaml 或 .yml 文件。');
    if (!(await this.fileExists(resolvedPath))) throw new Error('所选文件不存在。');
    const raw = await readFile(resolvedPath, 'utf8');
    try {
      YAML.parse(raw);
    } catch (error) {
      throw new Error(`YAML 语法错误：${this.errorMessage(error)}`);
    }
    const nextSettings = structuredClone(this.settings);
    const existing = nextSettings.sources.find((source) => normalizePath(source.path) === normalizePath(resolvedPath));
    const record: SourceRecord = existing ?? {
      id: randomUUID(),
      path: resolvedPath,
      snapshotPath: path.join(this.snapshotsDir, `${randomUUID()}.yaml`),
      displayName: path.basename(resolvedPath),
      addedAt: new Date().toISOString(),
    };
    record.path = resolvedPath;
    record.displayName = path.basename(resolvedPath);
    let createdSnapshot = false;
    try {
      if (!existing) {
        await copyFile(resolvedPath, record.snapshotPath);
        createdSnapshot = true;
        record.lastKnownHash = createHash('sha256').update(raw, 'utf8').digest('hex');
        nextSettings.sources.push(record);
      }
      if (select || !nextSettings.currentSourceId) nextSettings.currentSourceId = record.id;
      await this.saveSettings(nextSettings);
      this.settings = nextSettings;
      return structuredClone(record);
    } catch (error) {
      if (createdSnapshot) await rm(record.snapshotPath, { force: true });
      throw error;
    }
  }

  private async getSourceViews(): Promise<SourceView[]> {
    return Promise.all(this.settings.sources.map((source) => this.toSourceView(source)));
  }

  private async toSourceView(source: SourceRecord): Promise<SourceView> {
    let status: SourceView['status'] = 'missing';
    try {
      const currentHash = await this.hashFile(source.path);
      status = source.lastKnownHash && currentHash !== source.lastKnownHash ? 'changed' : 'ok';
    } catch {
      status = 'missing';
    }
    return {
      ...source,
      status,
      isCurrent: source.id === this.settings.currentSourceId,
    };
  }

  private async checkSourceChanges(): Promise<void> {
    if (this.closed) return;
    const views = await this.getSourceViews();
    const signature = views.map((source) => `${source.id}:${source.status}`).join('|');
    if (signature !== this.sourceStatusSignature) {
      this.sourceStatusSignature = signature;
      await this.emitState();
    }
  }

  private startSourceMonitor(): void {
    if (this.sourceCheckTimer) clearInterval(this.sourceCheckTimer);
    this.sourceCheckTimer = setInterval(() => {
      void this.checkSourceChanges();
    }, 2500);
    this.sourceCheckTimer.unref();
  }

  private async readSourceWithFallback(source: SourceRecord): Promise<{ sourcePath: string; raw: string }> {
    try {
      return { sourcePath: source.path, raw: await readFile(source.path, 'utf8') };
    } catch (sourceError) {
      try {
        const raw = await readFile(source.snapshotPath, 'utf8');
        this.appendLog(`原文件不可用，使用快照：${source.displayName}`);
        return { sourcePath: source.snapshotPath, raw };
      } catch (snapshotError) {
        throw new Error(
          `无法读取配置源 ${source.displayName}（${this.errorMessage(sourceError)}），保存的快照也不可用（${this.errorMessage(snapshotError)}）。`,
        );
      }
    }
  }

  private assertNoRelativeProviderPaths(parsed: unknown, sourcePath: string): void {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const root = parsed as Record<string, unknown>;
    for (const sectionName of ['proxy-providers', 'rule-providers']) {
      const section = root[sectionName];
      if (!section || typeof section !== 'object' || Array.isArray(section)) continue;
      for (const [providerName, providerValue] of Object.entries(section as Record<string, unknown>)) {
        if (!providerValue || typeof providerValue !== 'object' || Array.isArray(providerValue)) continue;
        const provider = providerValue as Record<string, unknown>;
        const resourcePath = typeof provider.path === 'string' ? provider.path.trim() : '';
        const isAbsolute = path.isAbsolute(resourcePath) || path.win32.isAbsolute(resourcePath);
        const isUrl = /^[a-z][a-z\d+.-]*:\/\//i.test(resourcePath);
        if (!resourcePath || isAbsolute || isUrl) continue;
        throw new Error(`${sectionName}「${providerName}」使用了相对路径 ${resourcePath}。请改为绝对路径后再刷新（源文件：${path.basename(sourcePath)}）。`);
      }
    }
  }

  private collectReservedPorts(parsed: unknown, startPort: number): Set<number> {
    const reserved = new Set<number>();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const root = parsed as Record<string, any>;
      for (const key of TOP_LEVEL_PORT_KEYS) {
        const value = safeInteger(root[key], key === 'mixed-port' ? 7890 : 0);
        if (value >= 1 && value <= 65535) reserved.add(value);
      }
      const dnsPort = this.addressPort(root.dns?.listen);
      if (dnsPort) reserved.add(dnsPort);
      const listeners = Array.isArray(root.listeners) ? root.listeners : [];
      for (const listener of listeners) {
        const value = safeInteger(listener?.port, 0);
        if (value >= 1 && value <= 65535) reserved.add(value);
      }
      for (const port of this.collectControllerPorts(root)) reserved.add(port);
    }
    if (Number.isInteger(startPort) && startPort >= 1 && startPort <= 65535) {
      for (let index = 0; index < 500 && startPort + index <= 65535; index += 1) {
        reserved.add(startPort + index);
      }
    }
    return reserved;
  }

  private async readActiveConfigPorts(): Promise<Set<number>> {
    const ports = new Set<number>();
    try {
      const raw = await readFile(this.activeConfigPath(), 'utf8');
      const parsed = YAML.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return ports;
      const root = parsed as Record<string, any>;
      for (const key of TOP_LEVEL_PORT_KEYS) {
        const value = safeInteger(root[key], key === 'mixed-port' ? 7890 : 0);
        if (value >= 1 && value <= 65535) ports.add(value);
      }
      const dnsPort = this.addressPort(root.dns?.listen);
      if (dnsPort) ports.add(dnsPort);
      const listeners = Array.isArray(root.listeners) ? root.listeners : [];
      for (const listener of listeners) {
        const value = safeInteger(listener?.port, 0);
        if (value >= 1 && value <= 65535) ports.add(value);
      }
      for (const port of this.collectControllerPorts(root)) ports.add(port);
    } catch {
      // No active config or an unreadable old config means there are no ports
      // that need special treatment during a refresh.
    }
    return ports;
  }

  private async readActiveConfigUdpPorts(): Promise<Set<number>> {
    try {
      const raw = await readFile(this.activeConfigPath(), 'utf8');
      return new Set(collectUdpListenerPorts(YAML.parse(raw)));
    } catch {
      return new Set<number>();
    }
  }

  private collectRuntimePorts(config: unknown): number[] {
    const ports = new Set<number>();
    if (!config || typeof config !== 'object' || Array.isArray(config)) return [];
    const root = config as Record<string, any>;
    for (const key of TOP_LEVEL_PORT_KEYS) {
      const value = safeInteger(root[key], key === 'mixed-port' ? 7890 : 0);
      if (value >= 1 && value <= 65535) ports.add(value);
    }
    const dnsPort = this.addressPort(root.dns?.listen);
    if (dnsPort) ports.add(dnsPort);
    for (const listener of Array.isArray(root.listeners) ? root.listeners : []) {
      const value = safeInteger(listener?.port, 0);
      if (value >= 1 && value <= 65535) ports.add(value);
    }
    for (const port of this.collectControllerPorts(root)) ports.add(port);
    return [...ports];
  }

  private async installGeneratedFiles(stageDir: string, snapshotTarget?: string, includeGeoIp = false): Promise<void> {
    await mkdir(this.activeDir, { recursive: true });
    const backupDir = path.join(this.runtimeDir, `backup-${randomUUID()}`);
    await mkdir(backupDir, { recursive: true });
    const files = [
      { key: 'config.yaml', staged: path.join(stageDir, 'config.yaml'), target: path.join(this.activeDir, 'config.yaml') },
      { key: 'proxy-import.txt', staged: path.join(stageDir, 'proxy-import.txt'), target: path.join(this.activeDir, 'proxy-import.txt') },
      { key: 'generation.json', staged: path.join(stageDir, 'generation.json'), target: path.join(this.activeDir, 'generation.json') },
      { key: 'settings.json', staged: path.join(stageDir, 'settings.json'), target: this.settingsPath },
      ...(includeGeoIp && await this.fileExists(path.join(stageDir, 'geoip.metadb'))
        ? [{ key: 'geoip.metadb', staged: path.join(stageDir, 'geoip.metadb'), target: path.join(this.activeDir, 'geoip.metadb') }]
        : []),
      ...(snapshotTarget
        ? [{ key: 'source-snapshot.yaml', staged: path.join(stageDir, 'source-snapshot.yaml'), target: snapshotTarget }]
        : []),
    ];
    const movedOld = new Set<string>();
    const movedNew = new Set<string>();
    let keepBackup = false;
    try {
      for (const file of files) {
        if (await this.fileExists(file.target)) {
          const backup = path.join(backupDir, file.key);
          await this.moveAcrossDirectories(file.target, backup);
          movedOld.add(file.key);
        }
      }
      for (const file of files) {
        await this.moveAcrossDirectories(file.staged, file.target);
        movedNew.add(file.key);
      }
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const file of [...files].reverse()) {
        try {
          const backup = path.join(backupDir, file.key);
          if (movedNew.has(file.key) || (movedOld.has(file.key) && await this.fileExists(file.target))) {
            await rm(file.target, { force: true });
          }
          if (movedOld.has(file.key) && (await this.fileExists(backup))) {
            await this.moveAcrossDirectories(backup, file.target);
          }
        } catch (rollbackError) {
          rollbackErrors.push(`${file.key}: ${this.errorMessage(rollbackError)}`);
        }
      }
      if (rollbackErrors.length > 0) {
        keepBackup = true;
        throw new Error(`${this.errorMessage(error)}；回滚未完全成功，备份保留在 ${backupDir}（${rollbackErrors.join('；')}）。`);
      }
      throw error;
    } finally {
      if (!keepBackup) {
        try {
          await rm(backupDir, { recursive: true, force: true });
        } catch (cleanupError) {
          this.appendLog(`临时备份目录清理失败：${this.errorMessage(cleanupError)}`);
        }
      }
    }
  }

  private async moveAcrossDirectories(sourcePath: string, targetPath: string): Promise<void> {
    await mkdir(path.dirname(targetPath), { recursive: true });
    try {
      await rename(sourcePath, targetPath);
    } catch (error) {
      // APPDATA and LOCALAPPDATA are normally on the same volume, but a
      // redirected profile can put them on different volumes.
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'EXDEV') throw error;
      await copyFile(sourcePath, targetPath);
      await rm(sourcePath, { force: true });
    }
  }

  private async validateConfig(homeDir: string, configPath: string): Promise<ValidationResult> {
    const binary = this.mihomoPath();
    if (!binary || !(await this.fileExists(binary))) throw new Error('找不到 Mihomo 核心文件。');
    if (this.closed) throw new Error('应用正在关闭，暂不执行配置校验。');
    return new Promise((resolve) => {
      let output = '';
      let settled = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      let timeoutResult: ValidationResult | undefined;
      const child = spawn(binary, ['-t', '-d', homeDir, '-f', configPath], {
        cwd: homeDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.validationProcesses.add(child);
      const append = (chunk: Buffer | string) => {
        output += String(chunk);
        if (output.length > 24000) output = output.slice(-24000);
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      const settle = (result: ValidationResult) => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (child.exitCode !== null) this.validationProcesses.delete(child);
        resolve(result);
      };
      child.once('error', (error) => {
        settle({ ok: false, output: `${output}\n${this.errorMessage(error)}` });
      });
      child.once('close', (code) => {
        this.validationProcesses.delete(child);
        settle(timeoutResult ?? { ok: code === 0, output });
      });
      timeoutHandle = setTimeout(() => {
        const timeoutValidation: ValidationResult = {
          ok: false,
          output: `${output}\nMihomo 配置校验超时（${VALIDATION_TIMEOUT_MS / 1000} 秒）。`,
        };
        timeoutResult = timeoutValidation;
        void this.terminateValidationProcess(child).then((stopped) => {
          if (stopped || !this.isChildAlive(child)) {
            settle(timeoutValidation);
          } else {
            settle({
              ok: false,
              output: `${timeoutValidation.output}\n无法确认校验进程已退出；请重试或关闭软件后检查 Mihomo 进程。`,
            });
          }
        });
      }, VALIDATION_TIMEOUT_MS);
      timeoutHandle.unref();
    });
  }

  private async terminateValidationProcesses(): Promise<void> {
    const processes = [...this.validationProcesses];
    if (processes.length === 0) return;
    const results = await Promise.all(processes.map((child) => this.terminateValidationProcess(child)));
    const stillAlive = processes.filter((child, index) => !results[index] && this.isChildAlive(child));
    if (stillAlive.length > 0) {
      throw new Error(`无法停止 ${stillAlive.length} 个 Mihomo 配置校验进程，软件将保持打开。`);
    }
  }

  private terminateValidationProcess(child: ManagedProcess): Promise<boolean> {
    const existing = this.validationStopPromises.get(child);
    if (existing) return existing;
    const promise = new Promise<boolean>((resolve) => {
      let finished = false;
      let forceTimer: NodeJS.Timeout | undefined;
      let verifyTimer: NodeJS.Timeout | undefined;
      const finish = (stopped: boolean) => {
        if (finished) return;
        finished = true;
        if (forceTimer) clearTimeout(forceTimer);
        if (verifyTimer) clearTimeout(verifyTimer);
        if (stopped) this.validationProcesses.delete(child);
        resolve(stopped);
      };
      const verify = () => finish(!this.isChildAlive(child));
      child.once('close', () => finish(true));
      if (!this.isChildAlive(child)) {
        finish(true);
        return;
      }
      try {
        child.kill();
      } catch {
        // Fall through to the force-stop path below.
      }
      forceTimer = setTimeout(() => {
        if (finished || !this.isChildAlive(child)) {
          finish(true);
          return;
        }
        if (process.platform === 'win32' && child.pid) {
          verifyTimer = setTimeout(verify, 3000);
          verifyTimer.unref();
          execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], () => {
            if (finished) return;
            if (verifyTimer) clearTimeout(verifyTimer);
            verifyTimer = setTimeout(verify, 1200);
            verifyTimer.unref();
          });
        } else {
          try { child.kill('SIGKILL'); } catch { /* The process may have exited. */ }
          verifyTimer = setTimeout(verify, 1200);
          verifyTimer.unref();
        }
      }, 1500);
      forceTimer.unref();
    });
    this.validationStopPromises.set(child, promise);
    void promise.finally(() => this.validationStopPromises.delete(child));
    return promise;
  }

  private async assertGeneratedPortsAvailable(
    tcpPorts: number[],
    udpPorts: number[],
    allowedTcpPorts = new Set<number>(),
    allowedUdpPorts = new Set<number>(),
  ): Promise<void> {
    await assertLocalPortsAvailable(tcpPorts, udpPorts, allowedTcpPorts, allowedUdpPorts);
  }

  private async findFreePort(reservedPorts = new Set<number>()): Promise<number> {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const port = await new Promise<number>((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          const selected = typeof address === 'object' && address ? address.port : 0;
          server.close((error) => (error ? reject(error) : resolve(selected)));
        });
      });
      if (port > 0 && !reservedPorts.has(port)) return port;
    }
    throw new Error('无法找到可用的本地控制端口。');
  }

  private async ensureBundledGeoIp(): Promise<void> {
    if (await this.fileExists(path.join(this.activeDir, 'geoip.metadb'))) return;
    await this.copyBundledGeoIp(this.activeDir);
  }

  private async copyBundledGeoIp(targetDir: string): Promise<void> {
    const source = this.geoIpPath();
    if (source && (await this.fileExists(source))) await copyFile(source, path.join(targetDir, 'geoip.metadb'));
  }

  private mihomoPath(): string | undefined {
    const packaged = path.join(process.resourcesPath, 'mihomo', 'mihomo.exe');
    const development = path.join(this.appRoot, 'mihomo.exe');
    return existsSync(packaged) ? packaged : existsSync(development) ? development : undefined;
  }

  private geoIpPath(): string | undefined {
    const packaged = path.join(process.resourcesPath, 'mihomo', 'geoip.metadb');
    const development = path.join(this.appRoot, 'geoip.metadb');
    return existsSync(packaged) ? packaged : existsSync(development) ? development : undefined;
  }

  private activeConfigPath(): string {
    return path.join(this.activeDir, 'config.yaml');
  }

  private addressPort(value: unknown): number | undefined {
    const match = String(value ?? '').trim().match(/:(\d+)\s*$/);
    const port = match ? safeInteger(match[1], 0) : 0;
    return port >= 1 && port <= 65535 ? port : undefined;
  }

  private collectControllerPorts(root: Record<string, any>): number[] {
    const ports = new Set<number>();
    for (const [key, value] of Object.entries(root)) {
      if (key !== 'external-controller' && !key.startsWith('external-controller-')) continue;
      const port = this.addressPort(value);
      if (port) ports.add(port);
    }
    return [...ports];
  }

  private isChildAlive(child: ManagedProcess): boolean {
    if (child.exitCode !== null || !child.pid) return false;
    try {
      process.kill(child.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException)?.code === 'EPERM';
    }
  }

  private isGenerationCurrent(generation: ActiveGeneration | undefined): boolean {
    const currentSource = this.settings.sources.find((source) => source.id === this.settings.currentSourceId);
    return Boolean(
      generation
      && currentSource
      && generation.sourceId === currentSource.id
      && generation.sourceHash === currentSource.lastKnownHash
      && generation.startPort === this.settings.startPort
      && generation.protocol === this.settings.protocol,
    );
  }

  private async readActiveGeneration(): Promise<ActiveGeneration | undefined> {
    try {
      const parsed = JSON.parse(await readFile(path.join(this.activeDir, 'generation.json'), 'utf8')) as Partial<ActiveGeneration>;
      if (
        typeof parsed.sourceId !== 'string'
        || typeof parsed.sourceHash !== 'string'
        || typeof parsed.configHash !== 'string'
        || typeof parsed.importHash !== 'string'
        || !Number.isInteger(parsed.startPort)
        || (parsed.protocol !== 'socks5' && parsed.protocol !== 'http')
        || typeof parsed.generatedAt !== 'string'
      ) return undefined;
      return parsed as ActiveGeneration;
    } catch {
      return undefined;
    }
  }

  private async isActiveBundleComplete(generation: ActiveGeneration | undefined): Promise<boolean> {
    if (!generation) return false;
    try {
      const [configHash, importHash] = await Promise.all([
        this.hashFile(this.activeConfigPath()),
        this.hashFile(path.join(this.activeDir, 'proxy-import.txt')),
      ]);
      return configHash === generation.configHash && importHash === generation.importHash;
    } catch {
      return false;
    }
  }

  private async readImportText(): Promise<string> {
    try {
      return await readFile(path.join(this.activeDir, 'proxy-import.txt'), 'utf8');
    } catch {
      return '';
    }
  }

  private async readMixedPort(): Promise<number> {
    try {
      const raw = await readFile(this.activeConfigPath(), 'utf8');
      const parsed = YAML.parse(raw) as Record<string, unknown> | null;
      const port = safeInteger(parsed?.['mixed-port'], 7890);
      return port >= 1 && port <= 65535 ? port : 7890;
    } catch {
      return 7890;
    }
  }

  private async hashFile(filePath: string): Promise<string> {
    const buffer = await readFile(filePath);
    return createHash('sha256').update(buffer).digest('hex');
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private isSourceRecord(value: unknown): value is SourceRecord {
    if (!value || typeof value !== 'object') return false;
    const source = value as Partial<SourceRecord>;
    return typeof source.id === 'string' && typeof source.path === 'string' && typeof source.snapshotPath === 'string' && typeof source.displayName === 'string';
  }

  private appendMihomoOutput(chunk: string): void {
    const lines = chunk.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const line of lines) this.appendLog(line, true);
  }

  private appendLog(message: string, notify = true): void {
    const line = formatLogLine(message);
    this.logs.push(line);
    if (this.logs.length > MAX_LOG_LINES) this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
    if (notify) this.emit('logs:line', line);
  }

  private async emitState(): Promise<void> {
    if (this.closed) return;
    this.emit('state:changed', await this.getState());
  }

  private cleanValidationOutput(output: string): string {
    return output.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim().slice(-500) || '未返回详细信息';
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
