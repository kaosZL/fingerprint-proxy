const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const { createHash } = require('node:crypto');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');
const YAML = require('yaml');
const { assertLocalPortsAvailable } = require('../dist/port-availability.js');

const appDir = path.resolve(__dirname, '..');
const fixtureDir = path.join(__dirname, 'fixtures');
const releaseDir = path.join(appDir, 'release');
const screenshotPath = path.join(releaseDir, 'verification-ui.png');
const minimumScreenshotPath = path.join(releaseDir, 'verification-ui-min.png');
const expectedCounts = new Map([
  ['demo-trojan.yaml', 3],
  ['demo-mixed.yaml', 3],
  ['config.example.yaml', 3],
]);

async function waitForState(page, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => window.fingerprintProxy.state.get());
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for application state.');
}

async function canConnect(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (connected) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(connected);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

async function assertRangeListening(startPort, count, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let failed = [];
  do {
    const results = await Promise.all(Array.from({ length: count }, (_, index) => canConnect(startPort + index, 250)));
    failed = results.flatMap((connected, index) => (connected ? [] : [startPort + index]));
    if (!failed.length) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.deepEqual(failed, [], `Generated TCP listeners did not open: ${failed.join(', ')}`);
}

async function findFreeMixedPort() {
  for (let port = 16000; port < 17000; port += 1) {
    try {
      await assertLocalPortsAvailable([port], [port]);
      return port;
    } catch {
      // Try the next deterministic test-only port.
    }
  }
  throw new Error('No free mixed port found for the isolated smoke test.');
}

async function prepareSmokeSources(roaming, tempRoot) {
  const sourceDir = path.join(tempRoot, 'YamlSources');
  const snapshotsDir = path.join(roaming, 'FingerprintProxy', 'sources', 'snapshots');
  await Promise.all([
    fsp.mkdir(sourceDir, { recursive: true }),
    fsp.mkdir(snapshotsDir, { recursive: true }),
  ]);
  const mixedPort = await findFreeMixedPort();
  const sources = [];
  let index = 0;
  for (const displayName of expectedCounts.keys()) {
    const fixturePath = displayName === 'config.example.yaml'
      ? path.resolve(appDir, '..', 'examples', displayName)
      : path.join(fixtureDir, displayName);
    const parsed = YAML.parse(await fsp.readFile(fixturePath, 'utf8'));
    parsed['mixed-port'] = mixedPort;
    const raw = YAML.stringify(parsed, { lineWidth: 0 });
    const id = `smoke-source-${index + 1}`;
    const sourcePath = path.join(sourceDir, displayName);
    const snapshotPath = path.join(snapshotsDir, `${id}.yaml`);
    await Promise.all([
      fsp.writeFile(sourcePath, raw, 'utf8'),
      fsp.writeFile(snapshotPath, raw, 'utf8'),
    ]);
    sources.push({
      id,
      path: sourcePath,
      snapshotPath,
      displayName,
      addedAt: new Date().toISOString(),
      lastKnownHash: createHash('sha256').update(raw, 'utf8').digest('hex'),
    });
    index += 1;
  }
  const settingsDir = path.join(roaming, 'FingerprintProxy');
  await fsp.writeFile(path.join(settingsDir, 'settings.json'), JSON.stringify({
    sources,
    currentSourceId: sources[0].id,
    startPort: 23001,
    protocol: 'socks5',
  }, null, 2), 'utf8');
  return { sources, mixedPort };
}

async function refreshWithAvailableRange(page, sourceId, protocol, candidates) {
  let lastError = '';
  for (const startPort of candidates) {
    const result = await page.evaluate(
      ({ sourceId: id, startPort: port, protocol: localProtocol }) => window.fingerprintProxy.sources.refresh({
        sourceId: id,
        startPort: port,
        protocol: localProtocol,
      }),
      { sourceId, startPort, protocol },
    );
    if (result.ok) return { result, startPort };
    lastError = result.error || 'Unknown refresh error';
    if (!/端口.*(?:占用|保留|权限)/u.test(lastError)) throw new Error(`Refresh ${sourceId} at ${startPort} failed: ${lastError}`);
  }
  throw new Error(`Could not find a free port range: ${lastError}`);
}

async function redactPathsForScreenshot(page) {
  await page.evaluate(() => {
    const safeRoot = 'C:\\Example\\YamlSources';
    const activePath = document.querySelector('#active-source-path');
    if (activePath) activePath.textContent = `${safeRoot}\\demo-mixed.yaml`;
    for (const sourcePath of document.querySelectorAll('.source-path')) {
      const sourceItem = sourcePath.closest('[data-source-id]');
      const name = sourceItem?.querySelector('.source-name')?.textContent?.trim() || 'example.yaml';
      sourcePath.textContent = `${safeRoot}\\${name}`;
      sourcePath.title = sourcePath.textContent;
    }
  });
}

async function main() {
  await fsp.mkdir(releaseDir, { recursive: true });
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'fingerprint-proxy-smoke-'));
  const roaming = path.join(tempRoot, 'Roaming');
  const local = path.join(tempRoot, 'Local');
  const userData = path.join(tempRoot, 'ElectronUserData');
  await Promise.all([fsp.mkdir(roaming, { recursive: true }), fsp.mkdir(local, { recursive: true })]);
  const prepared = await prepareSmokeSources(roaming, tempRoot);

  const env = { ...process.env, APPDATA: roaming, LOCALAPPDATA: local };
  delete env.ELECTRON_RUN_AS_NODE;
  let electronApp;
  let page;
  let succeeded = false;
  try {
    electronApp = await electron.launch({
      args: ['.', `--user-data-dir=${userData}`],
      cwd: appDir,
      env,
      timeout: 30_000,
    });
    page = await electronApp.firstWindow({ timeout: 30_000 });
    await page.waitForLoadState('domcontentloaded');
    const initial = await waitForState(
      page,
      (state) => state.sources.length === expectedCounts.size
        && state.activeGeneration
        && !state.configNeedsRefresh
        && state.mixedPort === prepared.mixedPort,
      45_000,
    );
    assert.equal(initial.sources.length, expectedCounts.size);
    assert.equal(initial.mixedPort, prepared.mixedPort);

    const summaries = [];
    const sourceOrder = ['demo-mixed.yaml', 'config.example.yaml', 'demo-trojan.yaml'];
    const baseCandidates = [23001, 25001, 27001, 29001, 31001, 33001, 35001, 37001, 39001, 41001, 43001, 45001, 47001, 49001, 51001, 53001, 55001, 57001, 59001, 61001];
    let finalSource;
    let finalStartPort;

    for (let index = 0; index < sourceOrder.length; index += 1) {
      const displayName = sourceOrder[index];
      const source = initial.sources.find((item) => item.displayName === displayName);
      assert.ok(source, `Missing seeded source ${displayName}`);
      await page.evaluate((sourceId) => window.fingerprintProxy.sources.select(sourceId), source.id);
      const candidates = baseCandidates.slice(index * 5).concat(baseCandidates.slice(0, index * 5));
      const { result, startPort } = await refreshWithAvailableRange(page, source.id, 'socks5', candidates);
      assert.equal(result.nodeCount, expectedCounts.get(displayName));
      summaries.push({ source: displayName, nodes: result.nodeCount, startPort });
      finalSource = source;
      finalStartPort = startPort;
    }

    const generatedState = await page.evaluate(() => window.fingerprintProxy.state.get());
    assert.equal(generatedState.configNeedsRefresh, false);
    assert.equal(generatedState.importText.trim().split(/\r?\n/u).length, 3);
    const copyResult = await page.evaluate(() => window.fingerprintProxy.proxyImport.copy());
    assert.equal(copyResult.ok, true);
    const clipboardText = await electronApp.evaluate(({ clipboard }) => clipboard.readText());
    assert.equal(clipboardText, generatedState.importText);

    await page.evaluate(() => window.fingerprintProxy.service.start());
    const running = await waitForState(page, (state) => state.service.state === 'running');
    assert.ok(running.service.pid);
    await assertRangeListening(finalStartPort, 3);

    const mixed = initial.sources.find((item) => item.displayName === 'demo-mixed.yaml');
    assert.ok(mixed);
    await page.evaluate((sourceId) => window.fingerprintProxy.sources.select(sourceId), mixed.id);
    const alternateCandidates = baseCandidates.filter((port) => port !== finalStartPort).reverse();
    const refreshedWhileRunning = await refreshWithAvailableRange(page, mixed.id, 'socks5', alternateCandidates);
    const pending = await page.evaluate(() => window.fingerprintProxy.state.get());
    assert.equal(pending.service.state, 'running');
    assert.equal(pending.service.pid, running.service.pid);
    assert.equal(pending.service.configPendingRestart, true);
    assert.equal(await canConnect(finalStartPort), true);
    assert.equal(await canConnect(refreshedWhileRunning.startPort), false);

    await page.evaluate(() => window.fingerprintProxy.service.restart());
    const restarted = await waitForState(
      page,
      (state) => state.service.state === 'running' && state.service.pid !== running.service.pid,
      30_000,
    );
    assert.equal(restarted.service.configPendingRestart, false);
    await assertRangeListening(refreshedWhileRunning.startPort, 3);
    await redactPathsForScreenshot(page);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1060, 700));
    await page.waitForTimeout(250);
    await page.screenshot({ path: minimumScreenshotPath });

    await page.evaluate(() => window.fingerprintProxy.service.stop());
    await waitForState(page, (state) => state.service.state === 'stopped');
    assert.equal(await canConnect(refreshedWhileRunning.startPort, 500), false);

    const activeImportPath = path.join(local, 'FingerprintProxy', 'runtime', 'active', 'proxy-import.txt');
    await fsp.appendFile(activeImportPath, '# tampered\n', 'utf8');
    const tamperedState = await page.evaluate(() => window.fingerprintProxy.state.get());
    assert.equal(tamperedState.configNeedsRefresh, true);
    assert.equal(tamperedState.importText, '');
    await assert.rejects(
      page.evaluate(() => window.fingerprintProxy.proxyImport.copy()),
      /尚未刷新|不能复制/u,
    );
    const tamperedStart = await page.evaluate(() => window.fingerprintProxy.service.start());
    assert.equal(tamperedStart.state, 'error');
    const restored = await refreshWithAvailableRange(page, mixed.id, 'socks5', [refreshedWhileRunning.startPort, ...alternateCandidates]);
    assert.equal(restored.result.nodeCount, 3);

    await page.evaluate((sourceId) => window.fingerprintProxy.sources.select(sourceId), finalSource.id);
    const staleState = await page.evaluate(() => window.fingerprintProxy.state.get());
    assert.equal(staleState.configNeedsRefresh, true);
    assert.equal(staleState.importText, '');
    await assert.rejects(
      page.evaluate(() => window.fingerprintProxy.proxyImport.copy()),
      /尚未刷新|不能复制/u,
    );
    const staleStart = await page.evaluate(() => window.fingerprintProxy.service.start());
    assert.equal(staleStart.state, 'error');

    process.stdout.write(`${JSON.stringify({ summaries, runningPorts: 3, restartedPorts: 3, screenshotPath, minimumScreenshotPath }, null, 2)}\n`);
    succeeded = true;
  } finally {
    if (page) {
      try { await page.evaluate(() => window.fingerprintProxy.service.stop()); } catch { /* App may already be closing. */ }
    }
    if (electronApp) await electronApp.close().catch(() => undefined);
    if (succeeded) await fsp.rm(tempRoot, { recursive: true, force: true });
    else process.stderr.write(`Smoke-test data preserved at ${tempRoot}\n`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
