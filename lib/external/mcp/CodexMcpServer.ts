import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { SetupService } from '../../cli/SetupService.js';
import {
  type DaemonState,
  getPackageVersion,
  resolveDaemonPaths,
} from '../../daemon/DaemonState.js';
import { type DaemonStatus, DaemonSupervisor } from '../../daemon/DaemonSupervisor.js';
import { JobStore } from '../../daemon/JobStore.js';
import { DEFAULT_FOLDER_NAMES } from '../../shared/folder-names.js';
import { PACKAGE_ROOT } from '../../shared/package-root.js';
import { WorkspaceResolver } from '../../shared/WorkspaceResolver.js';
import { TIER_ORDER, TOOLS } from './tools.js';

interface CodexMcpServerOptions {
  projectRoot?: string;
  supervisor?: DaemonSupervisorLike;
  waitUntilReadyMs?: number;
}

interface DaemonSupervisorLike {
  ensure(options: { projectRoot: string; waitUntilReadyMs?: number }): Promise<DaemonStatus>;
  status(projectRoot: string): Promise<DaemonStatus>;
  stop(options: { projectRoot: string; waitMs?: number }): Promise<DaemonStatus>;
}

interface CodexToolCallActor {
  role?: string;
  user?: string;
  sessionId?: string;
}

export const CODEX_LOCAL_TOOLS = [
  {
    name: 'alembic_codex_status',
    tier: 'agent',
    description:
      'Check Alembic Codex plugin status without starting the daemon. Reports workspace, Ghost data root, initialization, and daemon state.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'alembic_codex_diagnostics',
    tier: 'agent',
    description:
      'Run Alembic Codex runtime diagnostics without starting the daemon. Checks Node, npm, npx, package pinning, daemon version, offline fallback, and admin mode gate.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'alembic_codex_init',
    tier: 'agent',
    description:
      'Initialize Alembic for Codex plugin use. Defaults to Ghost mode and skips IDE file deployment.',
    inputSchema: {
      type: 'object',
      properties: {
        force: {
          type: 'boolean',
          description: 'Overwrite existing Alembic Codex setup artifacts.',
        },
        seed: { type: 'boolean', description: 'Create seed example Recipes.' },
        standard: {
          type: 'boolean',
          description: 'Write Alembic data into the project instead of the Ghost data root.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'alembic_codex_dashboard',
    tier: 'agent',
    description:
      'Start or connect to the project Alembic daemon and return the local Dashboard URL.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'alembic_codex_bootstrap',
    tier: 'agent',
    description:
      'Start or connect to the daemon and enqueue an internal Alembic bootstrap job. Returns immediately with a recoverable job id.',
    inputSchema: {
      type: 'object',
      properties: {
        maxFiles: { type: 'number', description: 'Maximum files to include in project analysis.' },
        skipGuard: { type: 'boolean', description: 'Skip Guard audit during bootstrap analysis.' },
        contentMaxLines: {
          type: 'number',
          description: 'Maximum lines of content sampled per file.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'alembic_codex_rescan',
    tier: 'agent',
    description:
      'Start or connect to the daemon and enqueue an internal Alembic rescan job. Returns immediately with a recoverable job id.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Short reason for the rescan.' },
        dimensions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional dimension ids to rescan.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'alembic_codex_job',
    tier: 'agent',
    description:
      'Read Alembic daemon job status from the local JobStore without starting the daemon. Pass jobId for one job, or omit it to list recent jobs.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: {
          type: 'string',
          description: 'Job id returned by alembic_codex_bootstrap or alembic_codex_rescan.',
        },
        kind: { type: 'string', enum: ['bootstrap', 'rescan'] },
        status: {
          type: 'string',
          enum: ['queued', 'running', 'completed', 'failed', 'cancelled'],
        },
        limit: { type: 'number', description: 'Maximum jobs to return when listing.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'alembic_codex_stop',
    tier: 'agent',
    description: 'Stop the current project Alembic daemon.',
    inputSchema: {
      type: 'object',
      properties: {
        waitMs: { type: 'number', description: 'Milliseconds to wait for graceful daemon stop.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'alembic_codex_cleanup',
    tier: 'agent',
    description:
      'Preview or explicitly clean Alembic Codex runtime files. Plugin uninstall never removes user data automatically; this tool requires confirm=true before deleting runtime state.',
    inputSchema: {
      type: 'object',
      properties: {
        confirm: {
          type: 'boolean',
          description: 'When true, stop the daemon and delete runtime state/log/job files.',
        },
      },
      additionalProperties: false,
    },
  },
];

export class CodexMcpServer {
  readonly projectRoot: string;
  readonly supervisor: DaemonSupervisorLike;
  readonly waitUntilReadyMs: number;
  readonly sessionId: string;
  sdkServer: SdkMcpServer | null = null;

  constructor(options: CodexMcpServerOptions = {}) {
    this.projectRoot = resolveProjectRoot(options.projectRoot);
    this.supervisor = options.supervisor || new DaemonSupervisor();
    this.waitUntilReadyMs = options.waitUntilReadyMs ?? 3000;
    this.sessionId = `codex-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async start(): Promise<void> {
    this.sdkServer = new SdkMcpServer(
      { name: 'alembic-codex', version: '0.1.0' },
      { capabilities: { tools: {} } }
    );
    this.registerHandlers();
    await this.sdkServer.connect(new StdioServerTransport());
    process.stderr.write(`Alembic Codex MCP ready — ${getVisibleCodexTools().length} tools\n`);
  }

  async shutdown(): Promise<void> {
    if (this.sdkServer) {
      await this.sdkServer.close();
    }
  }

  registerHandlers(): void {
    if (!this.sdkServer) {
      throw new Error('Codex MCP SDK server is not initialized');
    }
    const server = this.sdkServer.server;

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: getVisibleCodexTools(),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      try {
        const result = await this.handleToolCall(name, args || {});
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: isErrorResult(result) ? true : undefined,
        };
      } catch (err: unknown) {
        const result = failureResult(name, err instanceof Error ? err.message : String(err));
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: true,
        };
      }
    });
  }

  async handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'alembic_codex_status':
        return this.buildStatus();
      case 'alembic_codex_diagnostics':
        return this.buildDiagnostics();
      case 'alembic_codex_init':
        return this.initializeWorkspace(args);
      case 'alembic_codex_dashboard':
        return this.openDashboard();
      case 'alembic_codex_bootstrap':
        return this.enqueueJob('bootstrap', args);
      case 'alembic_codex_rescan':
        return this.enqueueJob('rescan', args);
      case 'alembic_codex_job':
        return this.readJob(args);
      case 'alembic_codex_stop':
        return this.stopDaemon(args);
      case 'alembic_codex_cleanup':
        return this.cleanupRuntime(args);
      default:
        return this.callDaemonTool(name, args);
    }
  }

  async buildStatus(): Promise<Record<string, unknown>> {
    const resolver = WorkspaceResolver.fromProject(this.projectRoot);
    const facts = resolver.toFacts();
    const daemonStatus = await this.supervisor.status(this.projectRoot);
    const initialized =
      existsSync(resolver.configPath) &&
      existsSync(resolver.databasePath) &&
      existsSync(resolver.knowledgeDir) &&
      existsSync(resolver.recipesDir);

    return {
      success: true,
      data: {
        initialized,
        projectRoot: this.projectRoot,
        registry: {
          registered: facts.registered,
          path: facts.registryPath,
          projectId: facts.projectId,
          expectedProjectId: facts.expectedProjectId,
        },
        workspace: {
          mode: facts.mode,
          ghost: facts.ghost,
          dataRoot: facts.dataRoot,
          dataRootSource: facts.dataRootSource,
          runtimeDir: resolver.runtimeDir,
          configPath: resolver.configPath,
          databasePath: resolver.databasePath,
          knowledgeDir: resolver.knowledgeDir,
          recipesDir: resolver.recipesDir,
          candidatesDir: resolver.candidatesDir,
          skillsDir: resolver.skillsDir,
          wikiDir: resolver.wikiDir,
        },
        projectArtifacts: {
          runtimeExists: existsSync(join(this.projectRoot, DEFAULT_FOLDER_NAMES.project.runtime)),
          knowledgeExists: existsSync(
            join(this.projectRoot, DEFAULT_FOLDER_NAMES.project.knowledgeBase)
          ),
          envExists: existsSync(join(this.projectRoot, '.env')),
          cursorDirExists: existsSync(join(this.projectRoot, DEFAULT_FOLDER_NAMES.ide.cursorRoot)),
          vscodeMcpExists: existsSync(join(this.projectRoot, '.vscode', 'mcp.json')),
        },
        daemon: summarizeDaemonStatus(daemonStatus),
        diagnostics: buildRuntimeDiagnostics(daemonStatus),
        nextActions: initialized
          ? [
              'Call alembic_task(operation=prime) before non-trivial coding tasks.',
              'Call alembic_guard after changing code.',
            ]
          : ['Call alembic_codex_init before using Alembic project knowledge.'],
      },
    };
  }

  async buildDiagnostics(): Promise<Record<string, unknown>> {
    const daemonStatus = await this.supervisor.status(this.projectRoot);
    return {
      success: true,
      data: buildRuntimeDiagnostics(daemonStatus),
    };
  }

  async initializeWorkspace(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const service = new SetupService({
      projectRoot: this.projectRoot,
      force: Boolean(args.force),
      seed: Boolean(args.seed),
      ghost: args.standard !== true,
      profile: 'codex-plugin',
      quiet: true,
    });
    const results = await service.run();
    const status = await this.buildStatus();
    const ok = results.every((result) => result.ok);
    return {
      success: ok,
      data: {
        profile: 'codex-plugin',
        results,
        status: (status as { data?: unknown }).data,
      },
      message: ok ? 'Alembic Codex workspace initialized.' : 'Alembic Codex initialization failed.',
    };
  }

  async openDashboard(): Promise<Record<string, unknown>> {
    const daemon = await this.supervisor.ensure({
      projectRoot: this.projectRoot,
      waitUntilReadyMs: this.waitUntilReadyMs,
    });
    if (!daemon.ready || !daemon.state) {
      return {
        success: false,
        message: daemon.message || 'Alembic daemon is not ready yet.',
        data: { daemon: summarizeDaemonStatus(daemon) },
      };
    }
    return {
      success: true,
      data: {
        dashboardUrl: daemon.state.dashboardUrl || daemon.state.url,
        daemon: summarizeDaemonStatus(daemon),
      },
    };
  }

  async stopDaemon(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const daemon = await this.supervisor.stop({
      projectRoot: this.projectRoot,
      waitMs: typeof args.waitMs === 'number' ? args.waitMs : 5000,
    });
    return {
      success: true,
      data: { daemon: summarizeDaemonStatus(daemon) },
      message: daemon.message || 'Alembic daemon stopped.',
    };
  }

  async cleanupRuntime(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const paths = resolveDaemonPaths(this.projectRoot);
    const targets = {
      dataRoot: paths.dataRoot,
      jobsDir: paths.jobsDir,
      lockDir: paths.lockDir,
      logPath: paths.logPath,
      pidPath: paths.pidPath,
      runtimeDir: paths.runtimeDir,
      statePath: paths.statePath,
    };

    if (args.confirm !== true) {
      return {
        success: true,
        data: {
          dryRun: true,
          targets,
        },
        message:
          'Dry run only. Plugin uninstall does not remove Alembic data. Re-run with confirm=true to delete daemon runtime state/log/job files.',
      };
    }

    await this.supervisor.stop({ projectRoot: this.projectRoot, waitMs: 5000 });
    rmSync(paths.statePath, { force: true });
    rmSync(paths.pidPath, { force: true });
    rmSync(paths.logPath, { force: true });
    rmSync(paths.lockDir, { force: true, recursive: true });
    rmSync(paths.jobsDir, { force: true, recursive: true });
    return {
      success: true,
      data: {
        dryRun: false,
        cleaned: targets,
      },
      message:
        'Alembic Codex daemon runtime state cleaned. Knowledge, Recipes, and project data were left intact.',
    };
  }

  async enqueueJob(kind: 'bootstrap' | 'rescan', args: Record<string, unknown>): Promise<unknown> {
    const daemon = await this.supervisor.ensure({
      projectRoot: this.projectRoot,
      waitUntilReadyMs: this.waitUntilReadyMs,
    });
    if (!daemon.ready || !daemon.state) {
      return failureResult(
        `alembic_codex_${kind}`,
        daemon.message || 'Alembic daemon is not ready yet.',
        { daemon: summarizeDaemonStatus(daemon) }
      );
    }
    if (!daemon.state.token) {
      return failureResult(
        `alembic_codex_${kind}`,
        'Alembic daemon token is missing. Restart the daemon and retry.',
        { daemon: summarizeDaemonStatus(daemon) }
      );
    }

    return callDaemonHttpEndpoint(
      daemon.state,
      `/api/v1/jobs/${kind}`,
      {
        method: 'POST',
        body: args,
      },
      `alembic_codex_${kind}`
    );
  }

  async readJob(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const daemonResult = await this.tryReadJobFromDaemon(args);
    if (daemonResult) {
      return daemonResult;
    }

    const store = new JobStore({ projectRoot: this.projectRoot });
    const jobId = typeof args.jobId === 'string' ? args.jobId : '';
    if (jobId) {
      const job = store.get(jobId);
      return job
        ? { success: true, data: { job } }
        : failureResult('alembic_codex_job', `Alembic job not found: ${jobId}`);
    }

    const kind = args.kind === 'bootstrap' || args.kind === 'rescan' ? args.kind : undefined;
    const status =
      args.status === 'queued' ||
      args.status === 'running' ||
      args.status === 'completed' ||
      args.status === 'failed' ||
      args.status === 'cancelled'
        ? args.status
        : undefined;
    const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : 20;
    return {
      success: true,
      data: {
        jobs: store.list({ kind, limit, status }),
      },
    };
  }

  async tryReadJobFromDaemon(
    args: Record<string, unknown>
  ): Promise<Record<string, unknown> | null> {
    let daemon: DaemonStatus;
    try {
      daemon = await this.supervisor.status(this.projectRoot);
    } catch {
      return null;
    }
    if (!daemon.ready || !daemon.state?.token) {
      return null;
    }

    const jobId = typeof args.jobId === 'string' ? args.jobId : '';
    const path = jobId
      ? `/api/v1/jobs/${encodeURIComponent(jobId)}`
      : `/api/v1/jobs${buildJobQuery(args)}`;
    try {
      const result = await callDaemonHttpEndpoint(
        daemon.state,
        path,
        { method: 'GET' },
        'alembic_codex_job'
      );
      return isErrorResult(result) ? null : (result as Record<string, unknown>);
    } catch {
      return null;
    }
  }

  async callDaemonTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!TOOLS.some((tool) => tool.name === name)) {
      return failureResult(name, `Unknown Alembic tool: ${name}`);
    }

    const daemon = await this.supervisor.ensure({
      projectRoot: this.projectRoot,
      waitUntilReadyMs: this.waitUntilReadyMs,
    });
    if (!daemon.ready || !daemon.state) {
      return failureResult(name, daemon.message || 'Alembic daemon is not ready yet.', {
        daemon: summarizeDaemonStatus(daemon),
      });
    }
    if (!daemon.state.token) {
      return failureResult(name, 'Alembic daemon token is missing. Restart the daemon and retry.', {
        daemon: summarizeDaemonStatus(daemon),
      });
    }

    return callDaemonBridge(daemon.state, name, args, {
      role: 'external_agent',
      user: process.env.USER || undefined,
      sessionId: this.sessionId,
    });
  }
}

export function getVisibleCodexTools(tierName = process.env.ALEMBIC_MCP_TIER || 'agent') {
  const effectiveTier = resolveEffectiveCodexTier(tierName);
  const maxTier = (TIER_ORDER as Record<string, number>)[effectiveTier] ?? TIER_ORDER.agent;
  const coreTools = TOOLS.filter(
    (tool) => ((TIER_ORDER as Record<string, number>)[tool.tier || 'agent'] ?? 0) <= maxTier
  );
  return [...CODEX_LOCAL_TOOLS, ...coreTools];
}

function resolveEffectiveCodexTier(tierName: string): string {
  if (tierName === 'admin' && process.env.ALEMBIC_CODEX_ENABLE_ADMIN !== '1') {
    return 'agent';
  }
  return tierName;
}

function buildRuntimeDiagnostics(daemonStatus: DaemonStatus): Record<string, unknown> {
  const packageVersion = getPackageVersion();
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] || '0', 10);
  const npm = probeCommand('npm');
  const npx = probeCommand('npx');
  const npmAvailable = npm.available === true;
  const npxAvailable = npx.available === true;
  const plugin = buildPluginDiagnostics(packageVersion);
  const requestedTier = process.env.ALEMBIC_MCP_TIER || 'agent';
  const effectiveTier = resolveEffectiveCodexTier(requestedTier);
  const adminEnabled = process.env.ALEMBIC_CODEX_ENABLE_ADMIN === '1';
  const checks = {
    adminGate: requestedTier !== 'admin' || adminEnabled,
    node: nodeMajor >= 22,
    npm: npmAvailable,
    npx: npxAvailable,
    packagePin: plugin.mcp.packagePin,
    pluginAssets: plugin.assets.ok,
    pluginManifest: plugin.manifest.ok,
    pluginSkills: plugin.skills.ok,
  };
  const issues = buildDiagnosticIssues({
    adminEnabled,
    checks,
    npm,
    npx,
    packageVersion,
    plugin,
    requestedTier,
  });

  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    issues,
    nextActions: buildDiagnosticNextActions(issues),
    node: {
      ok: checks.node,
      required: '>=22',
      recommended: '22 LTS',
      version: process.versions.node,
      execPath: process.execPath,
      modules: process.versions.modules,
    },
    commands: {
      npm,
      npx,
    },
    package: {
      name: 'alembic-ai',
      version: packageVersion,
      pinnedSpecifier: `alembic-ai@${packageVersion}`,
      mcpBinary: 'alembic-codex-mcp',
    },
    plugin,
    daemon: {
      ready: daemonStatus.ready,
      status: daemonStatus.status,
      stateVersion: daemonStatus.state?.version || null,
      healthVersion: readHealthVersion(daemonStatus.health),
    },
    codex: {
      requestedTier,
      effectiveTier,
      adminEnabled,
      adminMode: adminEnabled
        ? 'enabled-by-ALEMBIC_CODEX_ENABLE_ADMIN'
        : 'disabled-requires-ALEMBIC_CODEX_ENABLE_ADMIN=1',
    },
    offlineFallback: {
      note: 'The marketplace MCP config uses pinned npx. If first-run network access is unavailable, install the same pinned runtime globally and use alembic-codex-mcp from PATH.',
      globalInstall: `npm install -g alembic-ai@${packageVersion}`,
      command: 'alembic-codex-mcp',
    },
    cleanup: {
      automaticOnUninstall: false,
      command: 'alembic_codex_cleanup',
      defaultMode: 'dry-run',
    },
  };
}

interface PluginDiagnostics {
  assets: { missing: string[]; ok: boolean; required: string[] };
  manifest: { ok: boolean; path: string; version: string | null };
  mcp: {
    adminDisabledByDefault: boolean;
    agentTierByDefault: boolean;
    binary: string | null;
    command: string | null;
    ok: boolean;
    packagePin: boolean;
    path: string;
    pinnedSpecifier: string | null;
  };
  ok: boolean;
  readme: { mentionsPinnedRuntime: boolean; ok: boolean; path: string };
  root: string;
  skills: { missing: string[]; ok: boolean; required: string[] };
}

interface DiagnosticIssue {
  action: string;
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

function buildPluginDiagnostics(packageVersion: string): PluginDiagnostics {
  const pluginRoot = join(PACKAGE_ROOT, 'plugins', 'alembic-codex');
  const manifestPath = join(pluginRoot, '.codex-plugin', 'plugin.json');
  const mcpPath = join(pluginRoot, '.mcp.json');
  const readmePath = join(pluginRoot, 'README.md');
  const manifest = readJsonObject(manifestPath);
  const mcpConfig = readJsonObject(mcpPath);
  const manifestInterface = asPlainRecord(manifest.value?.interface);
  const manifestAssets = collectManifestAssetPaths(manifestInterface);
  const missingAssets = manifestAssets.filter((asset) => !existsSync(join(pluginRoot, asset)));
  const requiredSkills = [
    'alembic',
    'alembic-create',
    'alembic-devdocs',
    'alembic-guard',
    'alembic-recipes',
    'alembic-structure',
  ];
  const missingSkills = requiredSkills.filter(
    (skill) => !existsSync(join(pluginRoot, 'skills', skill, 'SKILL.md'))
  );
  const server = asPlainRecord(asPlainRecord(mcpConfig.value?.mcpServers)?.alembic);
  const args = Array.isArray(server?.args)
    ? server.args.filter((arg): arg is string => typeof arg === 'string')
    : [];
  const packageIndex = args.indexOf('--package');
  const pinnedSpecifier = packageIndex >= 0 ? args[packageIndex + 1] || null : null;
  const command = typeof server?.command === 'string' ? server.command : null;
  const env = asPlainRecord(server?.env);
  const binary = args.find((arg) => arg === 'alembic-codex-mcp') || null;
  const packagePin =
    command === 'npx' &&
    pinnedSpecifier === `alembic-ai@${packageVersion}` &&
    binary === 'alembic-codex-mcp' &&
    !args.includes('latest');
  const adminDisabledByDefault = env?.ALEMBIC_CODEX_ENABLE_ADMIN === '0';
  const agentTierByDefault = env?.ALEMBIC_MCP_TIER === 'agent';
  const readme = existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : '';
  const readmeOk = readme.includes(`alembic-ai@${packageVersion}`);

  return {
    assets: {
      missing: missingAssets,
      ok: manifestAssets.length > 0 && missingAssets.length === 0,
      required: manifestAssets,
    },
    manifest: {
      ok: manifest.ok && asString(manifest.value?.name) === 'alembic-codex',
      path: manifestPath,
      version: asString(manifest.value?.version) || null,
    },
    mcp: {
      adminDisabledByDefault,
      agentTierByDefault,
      binary,
      command,
      ok: packagePin && adminDisabledByDefault && agentTierByDefault,
      packagePin,
      path: mcpPath,
      pinnedSpecifier,
    },
    ok:
      manifest.ok &&
      packagePin &&
      adminDisabledByDefault &&
      agentTierByDefault &&
      missingAssets.length === 0 &&
      missingSkills.length === 0 &&
      readmeOk,
    readme: {
      mentionsPinnedRuntime: readmeOk,
      ok: readmeOk,
      path: readmePath,
    },
    root: pluginRoot,
    skills: {
      missing: missingSkills,
      ok: missingSkills.length === 0,
      required: requiredSkills,
    },
  };
}

function buildDiagnosticIssues(input: {
  adminEnabled: boolean;
  checks: Record<string, boolean>;
  npm: Record<string, unknown>;
  npx: Record<string, unknown>;
  packageVersion: string;
  plugin: PluginDiagnostics;
  requestedTier: string;
}): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];
  if (!input.checks.node) {
    issues.push({
      action:
        'Install Node.js 22 LTS or newer, then restart Codex. Keep MCP and daemon on the same Node executable.',
      code: 'NODE_VERSION_UNSUPPORTED',
      message: `Alembic Codex requires Node.js >=22; current runtime is ${process.versions.node}.`,
      severity: 'error',
    });
  }
  if (!input.checks.npm) {
    issues.push({
      action: 'Install npm or use a Node.js distribution that includes npm.',
      code: 'NPM_UNAVAILABLE',
      message: String(input.npm.error || 'npm is not available.'),
      severity: 'error',
    });
  }
  if (!input.checks.npx) {
    issues.push({
      action: `Install the pinned runtime globally with npm install -g alembic-ai@${input.packageVersion}.`,
      code: 'NPX_UNAVAILABLE',
      message: String(input.npx.error || 'npx is not available.'),
      severity: 'error',
    });
  }
  if (!input.checks.packagePin) {
    issues.push({
      action: `Update plugins/alembic-codex/.mcp.json to use npx --package alembic-ai@${input.packageVersion} alembic-codex-mcp.`,
      code: 'PLUGIN_RUNTIME_PIN_MISMATCH',
      message: 'Codex plugin MCP config is not pinned to the current Alembic runtime package.',
      severity: 'error',
    });
  }
  if (!input.checks.pluginManifest || !input.plugin.readme.ok) {
    issues.push({
      action: 'Run npm run verify:codex-plugin and repair plugin metadata before publishing.',
      code: 'PLUGIN_METADATA_INCOMPLETE',
      message: 'Codex plugin manifest or README metadata is incomplete.',
      severity: 'error',
    });
  }
  if (!input.checks.pluginAssets || !input.checks.pluginSkills) {
    issues.push({
      action: 'Restore missing plugin assets or skills under plugins/alembic-codex.',
      code: 'PLUGIN_ASSETS_OR_SKILLS_MISSING',
      message: 'Codex plugin assets or skills are missing from the package.',
      severity: 'error',
    });
  }
  if (input.requestedTier === 'admin' && !input.adminEnabled) {
    issues.push({
      action: 'Set ALEMBIC_CODEX_ENABLE_ADMIN=1 only for explicit admin workflows.',
      code: 'CODEX_ADMIN_OPT_IN_REQUIRED',
      message: 'Admin tier was requested, but the Codex-specific admin opt-in is disabled.',
      severity: 'warning',
    });
  }
  return issues;
}

function buildDiagnosticNextActions(issues: DiagnosticIssue[]): string[] {
  if (issues.length === 0) {
    return ['Alembic Codex runtime checks passed.'];
  }
  return [...new Set(issues.map((issue) => issue.action))];
}

function collectManifestAssetPaths(manifestInterface: Record<string, unknown> | null): string[] {
  const assets = [
    asString(manifestInterface?.composerIcon),
    asString(manifestInterface?.logo),
    ...(Array.isArray(manifestInterface?.screenshots)
      ? manifestInterface.screenshots.map((value) => asString(value))
      : []),
  ];
  return assets.filter((asset): asset is string => Boolean(asset));
}

function readJsonObject(filePath: string): { ok: boolean; value: Record<string, unknown> | null } {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    return { ok: Boolean(parsed && typeof parsed === 'object'), value: asPlainRecord(parsed) };
  } catch {
    return { ok: false, value: null };
  }
}

function probeCommand(command: string): Record<string, unknown> {
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    timeout: 2000,
  });
  const output = `${result.stdout || result.stderr || ''}`.trim();
  return {
    available: result.status === 0,
    version: result.status === 0 ? output : null,
    error:
      result.status === 0 ? null : result.error?.message || output || `Unable to run ${command}`,
  };
}

function readHealthVersion(health: Record<string, unknown> | null): string | null {
  const data = health?.data;
  if (!data || typeof data !== 'object') {
    return null;
  }
  const version = (data as { version?: unknown }).version;
  return typeof version === 'string' ? version : null;
}

async function callDaemonBridge(
  state: DaemonState,
  name: string,
  args: Record<string, unknown>,
  actor: CodexToolCallActor
): Promise<unknown> {
  const response = await fetch(`${state.url}/api/v1/mcp/call`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-alembic-daemon-token': state.token || '',
    },
    body: JSON.stringify({ name, args, actor }),
  });

  const payload = await readJsonResponse(response);
  if (response.ok) {
    return payload;
  }
  return failureResult(
    name,
    extractResponseError(payload) || `Daemon bridge returned ${response.status}`,
    {
      daemon: {
        url: state.url,
        pid: state.pid,
        port: state.port,
      },
      response: payload,
    }
  );
}

async function callDaemonHttpEndpoint(
  state: DaemonState,
  path: string,
  request: { body?: Record<string, unknown>; method: 'GET' | 'POST' },
  tool: string
): Promise<unknown> {
  const response = await fetch(`${state.url}${path}`, {
    method: request.method,
    headers: {
      'content-type': 'application/json',
      'x-alembic-daemon-token': state.token || '',
    },
    body: request.body ? JSON.stringify(request.body) : undefined,
  });

  const payload = await readJsonResponse(response);
  if (response.ok) {
    return payload;
  }
  return failureResult(
    tool,
    extractResponseError(payload) || `Daemon job API returned ${response.status}`,
    {
      daemon: {
        url: state.url,
        pid: state.pid,
        port: state.port,
      },
      response: payload,
    }
  );
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { success: false, message: text };
  }
}

function summarizeDaemonStatus(status: DaemonStatus): Record<string, unknown> {
  return {
    status: status.status,
    ready: status.ready,
    projectRoot: status.projectRoot,
    dataRoot: status.dataRoot,
    projectId: status.projectId,
    pidAlive: status.pidAlive,
    statePath: status.statePath,
    pidPath: status.pidPath,
    logPath: status.logPath,
    state: status.state
      ? {
          pid: status.state.pid,
          host: status.state.host,
          port: status.state.port,
          url: status.state.url,
          dashboardUrl: status.state.dashboardUrl,
          startedAt: status.state.startedAt,
          lastReadyAt: status.state.lastReadyAt,
        }
      : null,
    message: status.message,
  };
}

function failureResult(
  tool: string,
  message: string,
  data: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    success: false,
    message,
    errorCode: 'CODEX_MCP_ERROR',
    tool,
    data,
  };
}

function isErrorResult(result: unknown): boolean {
  if (!result || typeof result !== 'object') {
    return false;
  }
  const value = result as { ok?: unknown; success?: unknown; isError?: unknown };
  return value.ok === false || value.success === false || value.isError === true;
}

function extractResponseError(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const obj = payload as { message?: unknown; error?: { message?: unknown } };
  return typeof obj.message === 'string'
    ? obj.message
    : typeof obj.error?.message === 'string'
      ? obj.error.message
      : null;
}

function buildJobQuery(args: Record<string, unknown>): string {
  const params = new URLSearchParams();
  if (args.kind === 'bootstrap' || args.kind === 'rescan') {
    params.set('kind', args.kind);
  }
  if (
    args.status === 'queued' ||
    args.status === 'running' ||
    args.status === 'completed' ||
    args.status === 'failed' ||
    args.status === 'cancelled'
  ) {
    params.set('status', args.status);
  }
  if (typeof args.limit === 'number' && Number.isFinite(args.limit)) {
    params.set('limit', String(args.limit));
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function resolveProjectRoot(projectRoot?: string): string {
  return resolve(
    projectRoot ||
      process.env.ALEMBIC_PROJECT_DIR ||
      process.env.CODEX_WORKSPACE_DIR ||
      process.env.INIT_CWD ||
      process.env.PWD ||
      process.cwd()
  );
}

export async function startCodexMcpServer(): Promise<CodexMcpServer> {
  const server = new CodexMcpServer();
  await server.start();
  return server;
}

export default CodexMcpServer;
