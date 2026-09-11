const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const {
  assertLocalPortsAvailable,
  collectUdpListenerPorts,
} = require('../dist/port-availability.js');

async function bindUdpPort() {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind({ port: 0, address: '127.0.0.1', exclusive: true }, resolve);
  });
  return socket;
}

test('SOCKS listeners with udp enabled are selected for UDP probing', () => {
  const ports = collectUdpListenerPorts({
    listeners: [
      { name: 'fp1', type: 'socks', port: 20001, udp: true },
      { name: 'fp2', type: 'http', port: 20002 },
      { name: 'custom', type: 'socks', port: '20003', udp: false },
      { name: 'fp4', type: 'socks', port: '20004', udp: true },
    ],
  });
  assert.deepEqual(ports, [20001, 20004]);
});

test('plain and UDP DNS listeners are selected for UDP probing', () => {
  assert.deepEqual(collectUdpListenerPorts({ dns: { listen: '127.0.0.1:1053' } }), [1053]);
  assert.deepEqual(collectUdpListenerPorts({ dns: { listen: 'udp://127.0.0.1:2053' } }), [2053]);
  assert.deepEqual(collectUdpListenerPorts({ dns: { listen: 'tcp://127.0.0.1:3053' } }), []);
});

test('occupied UDP port rejects a SOCKS listener availability check', async (t) => {
  const socket = await bindUdpPort();
  t.after(() => socket.close());
  const { port } = socket.address();

  await assert.rejects(
    assertLocalPortsAvailable([port], [port]),
    new RegExp(`UDP 端口 ${port} 已被占用`, 'u'),
  );
});

test('UDP occupancy does not reject an HTTP-only TCP availability check', async (t) => {
  const socket = await bindUdpPort();
  t.after(() => socket.close());
  const { port } = socket.address();

  await assert.doesNotReject(assertLocalPortsAvailable([port], []));
});

test('managed UDP listener ports can be explicitly allowed during refresh', async (t) => {
  const socket = await bindUdpPort();
  t.after(() => socket.close());
  const { port } = socket.address();

  await assert.doesNotReject(assertLocalPortsAvailable([], [port], new Set(), new Set([port])));
});
