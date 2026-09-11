import YAML from 'yaml';
import { LocalProtocol, NodeSummary } from './shared';

const DEFAULT_MAX_NODES = 500;
const META_NAME_PATTERN = /流量|剩余|到期|套餐|过期|有效期|重置|已用/i;
const TOP_LEVEL_PORT_KEYS = ['port', 'mixed-port', 'socks-port', 'redir-port', 'tproxy-port'] as const;

export interface BuildOptions {
  startPort: number;
  protocol: LocalProtocol;
  controllerAddress: string;
  secret: string;
  maxNodes?: number;
}

export interface GeneratedConfig {
  config: Record<string, any>;
  yamlText: string;
  importText: string;
  nodes: NodeSummary[];
  warnings: string[];
  skipped: string[];
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function numericPort(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value >= 1 && value <= 65535 ? value : undefined;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : undefined;
  }
  return undefined;
}

function assertPortRange(startPort: number, nodeCount: number): void {
  if (!Number.isInteger(startPort) || startPort < 1024 || startPort > 65535) {
    throw new Error('指纹代理起始端口必须是 1024-65535 之间的整数。');
  }
  if (nodeCount > 0 && startPort + nodeCount - 1 > 65535) {
    throw new Error(`端口范围超出 65535：需要 ${startPort}-${startPort + nodeCount - 1}。`);
  }
}

export function sanitizeRemark(value: unknown, fallback: string): string {
  const cleaned = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[{}\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
}

function collectPort(value: unknown): number | undefined {
  return numericPort(value);
}

function addressPort(value: unknown): number | undefined {
  const text = String(value ?? '').trim();
  const match = text.match(/:(\d+)\s*$/);
  return match ? numericPort(match[1]) : undefined;
}

function forceLoopbackListen(value: unknown): unknown {
  const port = addressPort(value);
  if (!port) return value;
  const scheme = String(value).trim().match(/^([a-z][a-z\d+.-]*:\/\/)/i)?.[1] ?? '';
  return `${scheme}127.0.0.1:${port}`;
}

function assertNoPortConflicts(
  root: Record<string, any>,
  preservedListeners: any[],
  generatedPorts: number[],
  controllerAddress: string,
): void {
  const seen = new Map<number, string>();
  const add = (port: number | undefined, label: string) => {
    if (!port) return;
    const previous = seen.get(port);
    if (previous) throw new Error(`端口 ${port} 存在冲突（${previous} / ${label}）。`);
    seen.set(port, label);
  };

  for (const key of TOP_LEVEL_PORT_KEYS) {
    add(collectPort(root[key]), `源配置 ${key}`);
  }
  add(addressPort(root.dns?.listen), '源配置 DNS 监听');
  for (const listener of preservedListeners) {
    const port = collectPort(listener?.port);
    const label = `监听器 ${String(listener?.name ?? '未命名')}`;
    add(port, label);
  }
  for (const port of generatedPorts) {
    const previous = seen.get(port);
    if (previous) throw new Error(`生成端口 ${port} 与${previous}冲突。`);
    seen.set(port, '指纹代理监听器');
  }
  const controllerPort = addressPort(controllerAddress);
  const previous = controllerPort ? seen.get(controllerPort) : undefined;
  if (previous) {
    throw new Error(`控制端口 ${controllerPort} 与${previous}冲突，请修改起始端口或源配置。`);
  }
}

export function buildGeneratedConfig(sourceConfig: unknown, options: BuildOptions): GeneratedConfig {
  if (!sourceConfig || typeof sourceConfig !== 'object' || Array.isArray(sourceConfig)) {
    throw new Error('YAML 根节点必须是配置对象。');
  }

  const root = cloneValue(sourceConfig as Record<string, any>);
  const rawProxies = root.proxies;
  if (!Array.isArray(rawProxies)) {
    if (root['proxy-providers']) {
      throw new Error('该 YAML 只有 proxy-providers，没有展开的 proxies 节点，暂不支持直接生成指纹端口。');
    }
    throw new Error('YAML 中没有 proxies 节点。');
  }

  const warnings: string[] = [];
  const skipped: string[] = [];
  const retained: Record<string, any>[] = [];
  const removedNames = new Set<string>();
  const names = new Set<string>();

  for (const candidate of rawProxies) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      skipped.push('非对象节点');
      continue;
    }
    const name = String(candidate.name ?? '').trim();
    const type = String(candidate.type ?? '').trim();
    const server = String(candidate.server ?? '').trim();
    const port = numericPort(candidate.port);
    if (!name || !type || !server || !port) {
      if (name) removedNames.add(name);
      skipped.push(name || '缺少名称/类型/服务器/端口');
      continue;
    }
    if (META_NAME_PATTERN.test(name)) {
      removedNames.add(name);
      skipped.push(name);
      continue;
    }
    if (names.has(name)) {
      skipped.push(`${name}（重复）`);
      continue;
    }
    names.add(name);
    retained.push({ ...candidate, port });
  }

  if (retained.length === 0) throw new Error('过滤后没有可用代理节点。');

  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const selected = retained.slice(0, maxNodes);
  if (retained.length > selected.length) {
    const omitted = retained.slice(selected.length);
    for (const item of omitted) removedNames.add(String(item.name));
    warnings.push(`有效节点共 ${retained.length} 个，已按顺序生成前 ${selected.length} 个，省略 ${omitted.length} 个。`);
  }
  if (skipped.length > 0) warnings.push(`已跳过 ${skipped.length} 个无效、重复或元数据项。`);

  assertPortRange(options.startPort, selected.length);
  const generatedPorts = selected.map((_, index) => options.startPort + index);

  // Mihomo uses 7890 when mixed-port is omitted; make that effective value
  // visible before checking conflicts so a generated listener cannot shadow it.
  const mixedPort = numericPort(root['mixed-port']) ?? 7890;
  root['mixed-port'] = mixedPort;

  const sourceListeners = Array.isArray(root.listeners) ? root.listeners : [];
  const preservedListeners = sourceListeners
    .filter((listener: any) => !/^fp\d+$/i.test(String(listener?.name ?? '')))
    .map((listener: any) => (
      listener && typeof listener === 'object' && !Array.isArray(listener)
        ? { ...listener, listen: '127.0.0.1' }
        : listener
    ));
  if (root.dns && typeof root.dns === 'object' && !Array.isArray(root.dns) && root.dns.listen !== undefined) {
    root.dns = { ...root.dns, listen: forceLoopbackListen(root.dns.listen) };
  }
  assertNoPortConflicts(root, preservedListeners, generatedPorts, options.controllerAddress);

  root.proxies = selected;
  const selectedNames = new Set(selected.map((proxy) => String(proxy.name)));
  if (Array.isArray(root['proxy-groups'])) {
    root['proxy-groups'] = root['proxy-groups'].map((group: any) => {
      if (!group || typeof group !== 'object' || !Array.isArray(group.proxies)) return group;
      return {
        ...group,
        proxies: group.proxies.filter((name: unknown) => !removedNames.has(String(name)) || selectedNames.has(String(name))),
      };
    });
  }

  const generatedListeners = selected.map((proxy, index) => {
    const port = generatedPorts[index];
    const listener: Record<string, any> = {
      name: `fp${String(index + 1).padStart(2, '0')}`,
      type: options.protocol === 'http' ? 'http' : 'socks',
      port,
      listen: '127.0.0.1',
      proxy: proxy.name,
    };
    if (options.protocol === 'socks5') listener.udp = true;
    return listener;
  });

  root.listeners = [...preservedListeners, ...generatedListeners];
  root['allow-lan'] = false;
  root['bind-address'] = '127.0.0.1';
  for (const key of Object.keys(root)) {
    if (key.startsWith('external-controller-')) delete root[key];
  }
  root['external-controller'] = options.controllerAddress;
  root.secret = options.secret;

  const scheme = options.protocol === 'http' ? 'http' : 'socks5';
  const nodes = selected.map((proxy, index) => ({ name: String(proxy.name), port: generatedPorts[index] }));
  const importText = nodes.map((node, index) => `${scheme}://127.0.0.1:${node.port}{${sanitizeRemark(node.name, `节点 ${index + 1}`)}}`).join('\n') + '\n';
  const yamlText = YAML.stringify(root, { lineWidth: 0 });

  return { config: root, yamlText, importText, nodes, warnings, skipped };
}
