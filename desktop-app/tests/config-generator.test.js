const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { buildGeneratedConfig, sanitizeRemark } = require('../dist/config-generator.js');

const fixtureDir = path.join(__dirname, 'fixtures');

function load(name) {
  return YAML.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8'));
}

function options(overrides = {}) {
  return {
    startPort: 20001,
    protocol: 'socks5',
    controllerAddress: '127.0.0.1:41234',
    secret: 'test-secret',
    ...overrides,
  };
}

test('sanitized trojan fixture produces local SOCKS entries', () => {
  const result = buildGeneratedConfig(load('demo-trojan.yaml'), options());
  assert.equal(result.nodes.length, 3);
  assert.equal(result.nodes[0].port, 20001);
  assert.equal(result.nodes.at(-1).port, 20003);
  assert.equal(result.config.listeners.length, 3);
  assert.equal(result.config.listeners[0].type, 'socks');
  assert.equal(result.config.listeners[0].udp, true);
  assert.match(result.importText, /^socks5:\/\/127\.0\.0\.1:20001\{/u);
  assert.doesNotMatch(result.importText, /剩余流量|套餐到期/u);
});

test('sanitized mixed fixture preserves protocols and can produce HTTP entries', () => {
  const result = buildGeneratedConfig(load('demo-mixed.yaml'), options({ startPort: 31000, protocol: 'http' }));
  assert.equal(result.nodes.length, 3);
  assert.equal(result.config.listeners.length, 3);
  assert.equal(result.config.listeners[0].type, 'http');
  assert.equal(result.config.listeners[0].udp, undefined);
  assert.match(result.importText, /^http:\/\/127\.0\.0\.1:31000\{/u);
  assert.equal(result.config.proxies.some((proxy) => proxy.type === 'anytls'), true);
  assert.equal(result.config.proxies.some((proxy) => proxy.type === 'ss'), true);
});

test('existing generated fp listeners are replaced and custom listeners are forced to loopback', () => {
  const source = YAML.parse(fs.readFileSync(path.join(__dirname, '../../examples/config.example.yaml'), 'utf8'));
  const result = buildGeneratedConfig(source, options());
  assert.equal(result.config.listeners.filter((listener) => /^fp\d+$/i.test(listener.name)).length, 3);
  const customListener = result.config.listeners.find((listener) => listener.name === 'custom-http');
  assert.ok(customListener);
  assert.equal(customListener.listen, '127.0.0.1');
});

test('metadata, duplicates and dangerous remarks are removed or normalized', () => {
  const source = {
    proxies: [
      { name: '剩余流量：1 GB', type: 'trojan', server: 'one.example', port: 443 },
      { name: 'node {a}\n[b]', type: 'trojan', server: 'two.example', port: 443 },
      { name: 'node {a}\n[b]', type: 'trojan', server: 'three.example', port: 444 },
    ],
    'proxy-groups': [{ name: '选择', type: 'select', proxies: ['剩余流量：1 GB', 'node {a}\n[b]'] }],
  };
  const result = buildGeneratedConfig(source, options());
  assert.equal(result.nodes.length, 1);
  assert.equal(result.config['proxy-groups'][0].proxies.includes('剩余流量：1 GB'), false);
  assert.match(result.importText, /^socks5:\/\/127\.0\.0\.1:20001\{node a b\}\n$/u);
  assert.equal(sanitizeRemark('\u0000[]{} hello\nworld', 'fallback'), 'hello world');
});

test('more than 500 nodes is truncated in source order', () => {
  const source = { proxies: Array.from({ length: 503 }, (_, index) => ({ name: `node-${index}`, type: 'socks5', server: '127.0.0.1', port: 1000 + index })) };
  const result = buildGeneratedConfig(source, options({ startPort: 40000 }));
  assert.equal(result.nodes.length, 500);
  assert.equal(result.nodes.at(-1).name, 'node-499');
  assert.match(result.warnings.join(' '), /省略 3 个/u);
});

test('port range overflow is rejected', () => {
  assert.throws(() => buildGeneratedConfig({ proxies: [{ name: 'node', type: 'socks', server: '127.0.0.1', port: 1 }, { name: 'node2', type: 'socks', server: '127.0.0.1', port: 2 }] }, options({ startPort: 65535 })), /超出 65535/u);
});

test('default mixed-port participates in generated port conflict checks', () => {
  assert.throws(
    () => buildGeneratedConfig({ proxies: [{ name: 'node', type: 'socks', server: '127.0.0.1', port: 1 }] }, options({ startPort: 7890 })),
    /生成端口 7890 与源配置 mixed-port.*冲突/u,
  );
});

test('controller port cannot shadow a generated or preserved listener port', () => {
  const source = {
    proxies: [{ name: 'node', type: 'socks', server: '127.0.0.1', port: 1 }],
    listeners: [{ name: 'custom', type: 'http', port: 18080 }],
  };
  assert.throws(() => buildGeneratedConfig(source, options({ controllerAddress: '127.0.0.1:20001' })), /控制端口 20001/u);
  assert.throws(() => buildGeneratedConfig(source, options({ controllerAddress: '127.0.0.1:18080' })), /控制端口 18080/u);
});

test('top-level HTTP and DNS ports participate in conflicts and DNS is loopback-only', () => {
  const proxy = { name: 'node', type: 'socks', server: '127.0.0.1', port: 1 };
  assert.throws(
    () => buildGeneratedConfig({ port: 20001, proxies: [proxy] }, options()),
    /生成端口 20001 与源配置 port.*冲突/u,
  );
  assert.throws(
    () => buildGeneratedConfig({ dns: { listen: '0.0.0.0:20001' }, proxies: [proxy] }, options()),
    /生成端口 20001 与源配置 DNS 监听冲突/u,
  );
  const result = buildGeneratedConfig(
    { dns: { enable: true, listen: 'udp://0.0.0.0:1053' }, proxies: [proxy] },
    options(),
  );
  assert.equal(result.config.dns.listen, 'udp://127.0.0.1:1053');
});

test('alternate external controller endpoints are removed', () => {
  const result = buildGeneratedConfig({
    proxies: [{ name: 'node', type: 'socks', server: '127.0.0.1', port: 1 }],
    'external-controller-tls': '0.0.0.0:9443',
    'external-controller-unix': '/tmp/mihomo.sock',
    'external-controller-cors': { allowOrigins: ['*'] },
  }, options());
  assert.equal(result.config['external-controller'], '127.0.0.1:41234');
  assert.equal(result.config['external-controller-tls'], undefined);
  assert.equal(result.config['external-controller-unix'], undefined);
  assert.equal(result.config['external-controller-cors'], undefined);
});
