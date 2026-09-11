import { createSocket } from 'node:dgram';
import { createServer } from 'node:net';

const LOOPBACK_ADDRESS = '127.0.0.1';

function portInUseError(port: number, transport: 'TCP' | 'UDP'): Error {
  const prefix = transport === 'UDP' ? 'UDP ' : '';
  return new Error(`${prefix}端口 ${port} 已被占用，请修改起始端口。`);
}

function portReservedError(port: number, transport: 'TCP' | 'UDP'): Error {
  const prefix = transport === 'UDP' ? 'UDP ' : '';
  return new Error(`${prefix}端口 ${port} 被系统保留或权限不足，请修改起始端口。`);
}

async function assertTcpPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    let settled = false;

    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      server.removeAllListeners();
      try {
        server.close(() => (error ? reject(error) : resolve()));
      } catch {
        if (error) reject(error);
        else resolve();
      }
    };

    server.once('error', (error: NodeJS.ErrnoException) => {
      settle(
        error.code === 'EADDRINUSE'
          ? portInUseError(port, 'TCP')
          : error.code === 'EACCES'
            ? portReservedError(port, 'TCP')
            : error,
      );
    });
    server.listen(port, LOOPBACK_ADDRESS, () => settle());
  });
}

export async function assertUdpPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createSocket({ type: 'udp4', reuseAddr: false });
    let settled = false;

    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      try {
        socket.close(() => (error ? reject(error) : resolve()));
      } catch {
        if (error) reject(error);
        else resolve();
      }
    };

    socket.once('error', (error: NodeJS.ErrnoException) => {
      settle(
        error.code === 'EADDRINUSE'
          ? portInUseError(port, 'UDP')
          : error.code === 'EACCES'
            ? portReservedError(port, 'UDP')
            : error,
      );
    });
    socket.bind({ port, address: LOOPBACK_ADDRESS, exclusive: true }, () => settle());
  });
}

export async function assertLocalPortsAvailable(
  tcpPorts: Iterable<number>,
  udpPorts: Iterable<number>,
  allowedTcpPorts = new Set<number>(),
  allowedUdpPorts = new Set<number>(),
): Promise<void> {
  for (const port of new Set(tcpPorts)) {
    if (!allowedTcpPorts.has(port)) await assertTcpPortAvailable(port);
  }
  for (const port of new Set(udpPorts)) {
    if (!allowedUdpPorts.has(port)) await assertUdpPortAvailable(port);
  }
}

export function collectUdpListenerPorts(config: unknown): number[] {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return [];
  const root = config as Record<string, any>;
  const listeners = Array.isArray(root.listeners)
    ? root.listeners
    : [];
  const ports = new Set<number>();
  for (const listener of listeners) {
    const port = typeof listener?.port === 'number' ? listener.port : Number(listener?.port);
    if (listener?.udp === true && Number.isInteger(port) && port >= 1 && port <= 65535) ports.add(port);
  }
  const dnsListen = String(root.dns?.listen ?? '').trim();
  const dnsPortMatch = dnsListen.match(/:(\d+)\s*$/);
  const dnsPort = dnsPortMatch ? Number(dnsPortMatch[1]) : 0;
  const dnsScheme = dnsListen.match(/^([a-z][a-z\d+.-]*):\/\//i)?.[1]?.toLowerCase();
  if ((!dnsScheme || dnsScheme === 'udp' || dnsScheme === 'quic') && Number.isInteger(dnsPort) && dnsPort >= 1 && dnsPort <= 65535) {
    ports.add(dnsPort);
  }
  return [...ports];
}
