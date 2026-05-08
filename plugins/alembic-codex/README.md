# Alembic Codex Plugin

Alembic for Codex uses a lightweight MCP shim. The shim can report local status and diagnostics without initializing the database, then starts or connects to the per-workspace daemon only when project knowledge, Guard, Dashboard, bootstrap, or rescan work is requested.

## Runtime

- Node.js 22 or newer is required. Node 22 LTS is recommended for local development; keep the MCP shim and daemon on the same Node executable.
- The marketplace MCP config pins the runtime package as `alembic-ai@0.0.9`.
- The default MCP tier is `agent`; admin tools stay hidden unless both `ALEMBIC_MCP_TIER=admin` and `ALEMBIC_CODEX_ENABLE_ADMIN=1` are set.

## First Checks

Use `alembic_codex_diagnostics` first. It reports Node, npm, npx, package version, daemon version, plugin metadata checks, offline fallback guidance, cleanup policy, and structured `issues` / `nextActions`.

Use `alembic_codex_status` to inspect workspace initialization and daemon state without starting the daemon.

## Release Verification

Before publishing, run:

```bash
npm run verify:codex-plugin
```

The verifier checks the local Codex marketplace entry, pinned MCP runtime, lightweight `alembic-codex-mcp` binary, default agent tier, disabled admin gate, declared assets, shipped skills, default prompts, and README runtime fallback.

## Local Marketplace

This repository includes `.agents/plugins/marketplace.json` so local Codex builds can discover Alembic as an installable plugin entry. The entry points to `./plugins/alembic-codex`, marks installation as `AVAILABLE`, and uses `ON_INSTALL` authentication policy.

`npm run smoke:codex-plugin` packages the runtime, resolves this marketplace entry from the packed tarball, copies the plugin into a temporary install root, and validates the installed manifest, MCP config, assets, skills, and stdio MCP calls.

## Offline Fallback

The default plugin config launches through pinned `npx`. If the first run cannot reach the npm registry, install the same runtime version globally and run the MCP binary from `PATH`:

```bash
npm install -g alembic-ai@0.0.9
alembic-codex-mcp
```

## Cleanup Policy

Uninstalling the plugin never removes Alembic data automatically. Use `alembic_codex_cleanup` for an explicit cleanup flow. The default call is a dry run; `confirm=true` only removes daemon runtime state, logs, locks, and job files. Knowledge, Recipes, candidates, and project data are left intact.
