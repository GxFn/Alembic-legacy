#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const shouldRunDaemon = process.argv.includes('--daemon');
const keepTmp = process.argv.includes('--keep') || process.env.KEEP_SMOKE_TMP === '1';
const tmpRoot = mkdtempSync(join(tmpdir(), 'alembic-codex-smoke-'));
const packDir = join(tmpRoot, 'pack');
const extractDir = join(tmpRoot, 'extract');
const npmCacheDir = join(tmpRoot, 'npm-cache');
const projectRoot = join(tmpRoot, 'project');
const alembicHome = join(tmpRoot, 'home');
mkdirSync(packDir, { recursive: true });
mkdirSync(extractDir, { recursive: true });
mkdirSync(npmCacheDir, { recursive: true });
mkdirSync(projectRoot, { recursive: true });
mkdirSync(alembicHome, { recursive: true });
writeFileSync(
  join(projectRoot, 'package.json'),
  '{"name":"codex-smoke-project","type":"module"}\n'
);
writeFileSync(join(projectRoot, 'index.js'), 'export const smoke = true;\n');

const previousEnv = {
  ALEMBIC_HOME: process.env.ALEMBIC_HOME,
  ALEMBIC_PROJECT_DIR: process.env.ALEMBIC_PROJECT_DIR,
  CODEX_WORKSPACE_DIR: process.env.CODEX_WORKSPACE_DIR,
};

let server = null;

try {
  const packageJson = readJson(join(root, 'package.json'));
  assert(
    existsSync(join(root, 'dist', 'bin', 'codex-mcp.js')),
    'dist/bin/codex-mcp.js missing; run npm run build first'
  );
  assert(
    existsSync(join(root, 'dashboard', 'dist', 'index.html')),
    'dashboard/dist missing; run npm run build:dashboard first'
  );

  const pack = run('npm', ['pack', '--json', '--pack-destination', packDir, '--ignore-scripts'], {
    cwd: root,
    env: {
      ...process.env,
      HUSKY: '0',
      npm_config_cache: npmCacheDir,
    },
  });
  const packInfo = parseNpmPackJson(pack.stdout)[0];
  const tarball = join(packDir, packInfo.filename);
  assert(existsSync(tarball), `npm pack did not create ${tarball}`);

  const listing = run('tar', ['-tzf', tarball]).stdout.split('\n').filter(Boolean);
  for (const required of requiredPackageFiles(packageJson.version)) {
    assert(listing.includes(required), `packed tarball missing ${required}`);
  }

  run('tar', ['-xzf', tarball, '-C', extractDir]);
  const packageRoot = join(extractDir, 'package');
  const repoNodeModules = join(root, 'node_modules');
  if (existsSync(repoNodeModules) && !existsSync(join(packageRoot, 'node_modules'))) {
    symlinkSync(repoNodeModules, join(packageRoot, 'node_modules'), 'dir');
  }

  process.env.ALEMBIC_HOME = alembicHome;
  process.env.ALEMBIC_PROJECT_DIR = projectRoot;
  process.env.CODEX_WORKSPACE_DIR = projectRoot;
  process.env.ALEMBIC_QUIET = '1';

  const { CodexMcpServer } = await import(
    pathToFileURL(join(packageRoot, 'dist', 'lib', 'external', 'mcp', 'CodexMcpServer.js')).href
  );
  const { JobStore } = await import(
    pathToFileURL(join(packageRoot, 'dist', 'lib', 'daemon', 'JobStore.js')).href
  );

  server = new CodexMcpServer({ projectRoot, waitUntilReadyMs: 5000 });

  const diagnostics = await server.handleToolCall('alembic_codex_diagnostics', {});
  assertResult(diagnostics, 'diagnostics');
  assert(
    diagnostics.data?.package?.pinnedSpecifier === `alembic-ai@${packageJson.version}`,
    'diagnostics package pin mismatch'
  );
  assert(diagnostics.data?.plugin?.ok === true, 'diagnostics plugin checks did not pass');

  const beforeStatus = await server.handleToolCall('alembic_codex_status', {});
  assertResult(beforeStatus, 'status before init');
  assert(
    beforeStatus.data?.initialized === false,
    'fresh smoke workspace should start uninitialized'
  );

  const init = await server.handleToolCall('alembic_codex_init', {});
  assertResult(init, 'codex init');
  assert(init.data?.status?.initialized === true, 'codex init did not produce initialized status');

  const afterStatus = await server.handleToolCall('alembic_codex_status', {});
  assertResult(afterStatus, 'status after init');
  assert(afterStatus.data?.initialized === true, 'status after init should be initialized');
  assert(afterStatus.data?.workspace?.ghost === true, 'codex init should default to Ghost mode');

  const store = new JobStore({ projectRoot });
  const localJob = store.create({ kind: 'rescan', request: { reason: 'smoke' }, source: 'codex' });
  const job = await server.handleToolCall('alembic_codex_job', { jobId: localJob.id });
  assertResult(job, 'local job lookup');
  assert(job.data?.job?.id === localJob.id, 'local job lookup returned the wrong job');

  let daemon = null;
  if (shouldRunDaemon) {
    daemon = await server.handleToolCall('alembic_codex_dashboard', {});
    assertResult(daemon, 'dashboard daemon smoke');
    assert(
      typeof daemon.data?.dashboardUrl === 'string',
      'dashboard daemon smoke did not return a URL'
    );
    await server.handleToolCall('alembic_codex_stop', {});
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        package: packInfo.filename,
        packageVersion: packageJson.version,
        projectRoot,
        alembicHome,
        daemon: shouldRunDaemon ? daemon?.data?.dashboardUrl || null : 'skipped',
      },
      null,
      2
    )
  );
} finally {
  if (server && shouldRunDaemon) {
    try {
      await server.handleToolCall('alembic_codex_stop', {});
    } catch {
      /* best effort */
    }
  }
  restoreEnv(previousEnv);
  if (!keepTmp) {
    rmSync(tmpRoot, { recursive: true, force: true });
  } else {
    console.error(`Smoke temp kept at ${tmpRoot}`);
  }
}

function requiredPackageFiles(version) {
  return [
    'package/dist/bin/codex-mcp.js',
    'package/dist/bin/daemon-server.js',
    'package/dist/lib/external/mcp/CodexMcpServer.js',
    'package/dist/lib/daemon/DaemonSupervisor.js',
    'package/dashboard/dist/index.html',
    'package/plugins/alembic-codex/.codex-plugin/plugin.json',
    'package/plugins/alembic-codex/.mcp.json',
    'package/plugins/alembic-codex/README.md',
    'package/plugins/alembic-codex/assets/alembic-codex-status.svg',
    'package/plugins/alembic-codex/skills/alembic/SKILL.md',
    'package/scripts/verify-codex-plugin.mjs',
    'package/scripts/smoke-codex-plugin.mjs',
    'package/package.json',
  ].map((file) => file.replace('<version>', version));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed\n${result.stdout || ''}${result.stderr || ''}`
    );
  }
  return result;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function parseNpmPackJson(stdout) {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start < 0 || end < start) {
    throw new Error(`npm pack did not emit JSON output:\n${stdout}`);
  }
  return JSON.parse(stdout.slice(start, end + 1));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertResult(result, label) {
  assert(result && typeof result === 'object', `${label} did not return an object`);
  assert(result.success === true, `${label} failed: ${result.message || JSON.stringify(result)}`);
}

function restoreEnv(env) {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
