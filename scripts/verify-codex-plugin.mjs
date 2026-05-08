#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const packageJson = readJson(join(root, 'package.json'));
const pluginRoot = join(root, 'plugins', 'alembic-codex');
const pluginJsonPath = join(pluginRoot, '.codex-plugin', 'plugin.json');
const mcpJsonPath = join(pluginRoot, '.mcp.json');
const marketplacePath = join(root, '.agents', 'plugins', 'marketplace.json');
const readmePath = join(pluginRoot, 'README.md');
const pluginJson = readJson(pluginJsonPath);
const mcpJson = readJson(mcpJsonPath);
const marketplaceJson = readJson(marketplacePath);
const errors = [];
const iface = pluginJson.interface || {};

const packageVersion = packageJson.version;
const expectedRuntime = `alembic-ai@${packageVersion}`;
const server = mcpJson.mcpServers?.alembic;
const args = Array.isArray(server?.args) ? server.args : [];
const packageIndex = args.indexOf('--package');
const pinnedSpecifier = packageIndex >= 0 ? args[packageIndex + 1] : null;
const marketplaceEntry = Array.isArray(marketplaceJson.plugins)
  ? marketplaceJson.plugins.find((entry) => entry?.name === 'alembic-codex')
  : null;

expect(
  packageJson.bin?.['alembic-codex-mcp'] === 'dist/bin/codex-mcp.js',
  'package.json must expose bin.alembic-codex-mcp -> dist/bin/codex-mcp.js'
);
expect(
  Array.isArray(packageJson.files) &&
    packageJson.files.includes('.agents/plugins/marketplace.json'),
  'package.json files[] must include .agents/plugins/marketplace.json'
);
expect(
  Array.isArray(packageJson.files) && packageJson.files.includes('plugins'),
  'package.json files[] must include plugins so the Codex plugin ships with npm package'
);
expect(
  Array.isArray(packageJson.files) && packageJson.files.includes('scripts/verify-codex-plugin.mjs'),
  'package.json files[] must include scripts/verify-codex-plugin.mjs'
);
expect(
  Array.isArray(packageJson.files) && packageJson.files.includes('scripts/smoke-codex-plugin.mjs'),
  'package.json files[] must include scripts/smoke-codex-plugin.mjs'
);
expect(pluginJson.name === 'alembic-codex', 'plugin.json name must be alembic-codex');
expect(pluginJson.interface?.displayName === 'Alembic', 'plugin displayName must be Alembic');
expect(server?.command === 'npx', '.mcp.json must launch through npx');
expect(args.includes('--package'), '.mcp.json npx args must include --package');
expect(
  pinnedSpecifier === expectedRuntime,
  `.mcp.json must pin runtime to ${expectedRuntime}; found ${pinnedSpecifier || '<missing>'}`
);
expect(args.includes('alembic-codex-mcp'), '.mcp.json must call alembic-codex-mcp');
expect(!args.includes('latest'), '.mcp.json must not use latest');
expect(server?.env?.ALEMBIC_MCP_TIER === 'agent', '.mcp.json must default to agent tier');
expect(
  server?.env?.ALEMBIC_CODEX_ENABLE_ADMIN === '0',
  '.mcp.json must disable Codex admin tools by default'
);
expect(
  marketplaceJson.name === 'alembic-codex-marketplace',
  '.agents/plugins/marketplace.json must name the marketplace alembic-codex-marketplace'
);
expect(
  marketplaceJson.interface?.displayName === 'Alembic',
  '.agents/plugins/marketplace.json must display as Alembic'
);
expect(Boolean(marketplaceEntry), '.agents/plugins/marketplace.json must include alembic-codex');
if (marketplaceEntry) {
  expect(
    marketplaceEntry.source?.source === 'local',
    'marketplace alembic-codex source must be local'
  );
  expect(
    marketplaceEntry.source?.path === './plugins/alembic-codex',
    'marketplace alembic-codex path must be ./plugins/alembic-codex'
  );
  expect(
    resolve(root, marketplaceEntry.source?.path || '') === pluginRoot,
    'marketplace alembic-codex path must resolve to the plugin root'
  );
  expect(
    marketplaceEntry.policy?.installation === 'AVAILABLE',
    'marketplace alembic-codex installation policy must be AVAILABLE'
  );
  expect(
    marketplaceEntry.policy?.authentication === 'ON_INSTALL',
    'marketplace alembic-codex authentication policy must be ON_INSTALL'
  );
  expect(
    marketplaceEntry.category === iface.category,
    'marketplace alembic-codex category must match plugin interface category'
  );
}

const assets = [
  iface.composerIcon,
  iface.logo,
  ...(Array.isArray(iface.screenshots) ? iface.screenshots : []),
].filter(Boolean);
expect(assets.length >= 3, 'plugin interface should declare composerIcon, logo, and screenshots');
for (const asset of assets) {
  expect(existsSync(join(pluginRoot, asset)), `missing plugin asset: ${asset}`);
}

const prompts = Array.isArray(iface.defaultPrompt)
  ? iface.defaultPrompt.join('\n').toLowerCase()
  : '';
for (const keyword of ['diagnostics', 'status', 'bootstrap', 'prime', 'guard']) {
  expect(prompts.includes(keyword), `default prompts should include ${keyword}`);
}

for (const skill of [
  'alembic',
  'alembic-create',
  'alembic-devdocs',
  'alembic-guard',
  'alembic-recipes',
  'alembic-structure',
]) {
  expect(existsSync(join(pluginRoot, 'skills', skill, 'SKILL.md')), `missing skill: ${skill}`);
}

const readme = existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : '';
expect(readme.includes(expectedRuntime), `README.md must mention ${expectedRuntime}`);
expect(
  readme.includes('alembic_codex_diagnostics'),
  'README.md must document alembic_codex_diagnostics'
);
expect(readme.includes('alembic_codex_cleanup'), 'README.md must document cleanup policy');

if (errors.length > 0) {
  console.error('Codex plugin verification failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`Codex plugin verification passed (${expectedRuntime}).`);

function expect(condition, message) {
  if (!condition) {
    errors.push(message);
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    errors.push(`Unable to read JSON ${path}: ${error.message}`);
    return {};
  }
}
