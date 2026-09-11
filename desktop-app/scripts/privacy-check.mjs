import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const candidates = execFileSync(
  'git',
  ['-C', repoRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { encoding: 'buffer' },
)
  .toString('utf8')
  .split('\0')
  .filter(Boolean);

const forbiddenPaths = new Set([
  'config.yaml',
  'proxy-import.txt',
  'cache.db',
  'mihomo.exe',
  'geoip.metadb',
  'desktop-app/geoip.metadb',
  'start.bat',
]);

const allowedYamlRoots = new Set([
  'examples/config.example.yaml',
  'desktop-app/tests/fixtures/demo-trojan.yaml',
  'desktop-app/tests/fixtures/demo-mixed.yaml',
]);

const safeNonConfigYaml = (file) => file.startsWith('.github/workflows/');

const failures = [];
for (const file of candidates) {
  const normalized = file.replace(/\\/gu, '/');
  if (forbiddenPaths.has(normalized)) {
    failures.push(`Blocked private or generated file: ${normalized}`);
    continue;
  }

  if (!/\.ya?ml$/iu.test(normalized)) continue;
  if (safeNonConfigYaml(normalized)) continue;
  if (!allowedYamlRoots.has(normalized)) {
    failures.push(`Unexpected YAML file requires a privacy review: ${normalized}`);
    continue;
  }

  const absolutePath = path.join(repoRoot, normalized);
  if (!existsSync(absolutePath)) continue;
  const content = readFileSync(absolutePath, 'utf8');
  const lines = content.split(/\r?\n/gu);
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^\s*(server|password|uuid|private-key|token|sni|servername)\s*:\s*(.*?)\s*(?:#.*)?$/iu);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].replace(/^['"]|['"]$/gu, '').trim();
    const safe = key === 'server' || key === 'sni' || key === 'servername'
      ? value === 'example.invalid' || value === '127.0.0.1'
      : value === 'CHANGE_ME' || value.startsWith('demo-');
    if (!safe) failures.push(`Unsafe ${key} value in ${normalized}:${index + 1}`);
  }
}

if (failures.length) {
  console.error('Privacy check failed. Do not publish subscription data or generated local files.');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Privacy check passed for ${candidates.length} publishable files.`);
}
