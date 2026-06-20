/**
 * Tier-4 "Full Sandbox" tools for the ThinkAgent.
 *
 * `@cloudflare/think`'s own `createSandboxTools` is still an unimplemented stub
 * (it returns an empty ToolSet and logs a warning), so this wires VibeSDK's
 * existing `@cloudflare/sandbox` container (the `Sandbox` / `UserAppSandboxService`
 * binding) into the ThinkAgent directly.
 *
 * The `think` behavior previews via SpaceDO + WorkerLoader (Tiers 0-2) and has
 * no shell by default. These tools add a real Linux container: the agent can
 * run its project's actual toolchain (`bun install`, `bun run build`, `bun test`,
 * `tsc`, `git`, ...) against the live SpaceDO workspace and read back real
 * stdout/stderr/exit codes to self-correct.
 *
 * The container cold-starts lazily and can momentarily report "no container
 * instance ... try again later" or a not-yet-ready control port; `withSandboxRetry`
 * absorbs that with bounded exponential backoff.
 */
import { tool, type Tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { getSandbox } from '@cloudflare/sandbox';
import type { SpaceWorkspaceStub } from './space-workspace-ops';
import { createObjectLogger, type StructuredLogger } from '../../logger';

/** Project root inside the container. */
const WORKDIR = '/workspace/project';
/** Directories never synced from the workspace into the container. */
const SKIP_DIRS = /(^|\/)(node_modules|\.git|dist|build|\.wrangler)(\/|$)/;
/** Keep tool output bounded so a noisy build log can't blow up the context. */
const MAX_STREAM_CHARS = 12_000;

function truncate(s: string | undefined): string {
	if (!s) return '';
	return s.length > MAX_STREAM_CHARS
		? `${s.slice(0, MAX_STREAM_CHARS)}\n…[truncated ${s.length - MAX_STREAM_CHARS} chars]`
		: s;
}

/** True for the transient container-provisioning / readiness errors. */
function isTransientSandboxError(message: string): boolean {
	return /no container instance|try again later|retry in a moment|please retry|container is starting|container is not ready|not ready yet|not listening|provision|starting up|cold|503|502/i.test(
		message,
	);
}

/**
 * Run `fn`, retrying transient container cold-start errors with bounded
 * exponential backoff (~2s,4s,8s,15s,15s → up to ~44s total), which covers a
 * typical container cold start.
 */
async function withSandboxRetry<T>(
	fn: () => Promise<T>,
	logger: StructuredLogger,
	tries = 5,
): Promise<T> {
	let lastErr: unknown;
	for (let attempt = 0; attempt < tries; attempt++) {
		try {
			return await fn();
		} catch (e) {
			lastErr = e;
			const message = e instanceof Error ? e.message : String(e);
			if (attempt < tries - 1 && isTransientSandboxError(message)) {
				const delay = Math.min(2_000 * 2 ** attempt, 15_000);
				logger.info('Sandbox cold-start retry', { attempt: attempt + 1, delay, message });
				await new Promise((r) => setTimeout(r, delay));
				continue;
			}
			throw e;
		}
	}
	throw lastErr;
}

type AnySandbox = {
	mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
	writeFile(path: string, content: string): Promise<unknown>;
	exec(command: string, options?: { cwd?: string; timeout?: number }): Promise<{
		success: boolean;
		exitCode: number;
		stdout: string;
		stderr: string;
	}>;
};

/**
 * Mirror the current SpaceDO source tree into the container's WORKDIR. Source
 * files only — `node_modules`/build output stay in the container across calls,
 * so `bun install` then `bun run build` works without re-installing.
 */
async function syncWorkspace(
	stub: SpaceWorkspaceStub,
	sandbox: AnySandbox,
	logger: StructuredLogger,
): Promise<number> {
	let paths: string[];
	try {
		paths = await stub.glob('**/*');
	} catch (e) {
		logger.warn('Workspace glob failed; running against existing container state', { error: String(e) });
		return 0;
	}
	const files = paths.filter((p) => !SKIP_DIRS.test(p));
	let written = 0;
	for (const path of files) {
		const content = await stub.readFile(path).catch(() => null);
		if (content == null) continue;
		try {
			await sandbox.writeFile(`${WORKDIR}/${path}`, content);
			written++;
		} catch (e) {
			logger.warn('Failed to sync file into sandbox', { path, error: String(e) });
		}
	}
	return written;
}

export interface SandboxToolsOptions {
	env: { Sandbox: DurableObjectNamespace };
	getStub: () => SpaceWorkspaceStub;
	getAgentId: () => string;
	logger?: StructuredLogger;
}

/**
 * Build the Tier-4 sandbox ToolSet. Spread into `ThinkAgent.getTools()`.
 */
export function createSandboxTools(opts: SandboxToolsOptions): ToolSet {
	const { env, getStub, getAgentId } = opts;
	const logger = opts.logger ?? createObjectLogger({ id: 'ThinkSandbox' }, 'ThinkSandboxTools');

	const getContainer = (): AnySandbox =>
		getSandbox(env.Sandbox as never, getAgentId()) as unknown as AnySandbox;

	const run_command: Tool = tool({
		description: [
			'Run a shell command in a full Linux sandbox container (Tier 4) preloaded with your project files.',
			'',
			'Use it to run your project\'s real toolchain and self-verify: `bun install`, `bun run build`, `bun test`, `tsc --noEmit`, `git ...`, etc. The container has network access and persists installed dependencies between calls within a turn.',
			'',
			'Before each run the current workspace source is synced in, so write/edit your files first, then run the command and read stdout/stderr/exitCode to fix real failures.',
			'',
			'Returns JSON: { exitCode, success, stdout, stderr }.',
		].join('\n'),
		inputSchema: z.object({
			command: z
				.string()
				.describe('Shell command to run, e.g. "bun install && bun run build".'),
			timeout_ms: z
				.number()
				.int()
				.positive()
				.optional()
				.describe('Max runtime in milliseconds (default 120000).'),
		}),
		execute: async (args: { command: string; timeout_ms?: number }) => {
			const timeout = args.timeout_ms ?? 120_000;
			try {
				const sandbox = getContainer();
				await withSandboxRetry(() => sandbox.mkdir(WORKDIR, { recursive: true }), logger);
				const synced = await syncWorkspace(getStub(), sandbox, logger);
				logger.info('Running sandbox command', { command: args.command, synced });
				const result = await withSandboxRetry(
					() => sandbox.exec(args.command, { cwd: WORKDIR, timeout }),
					logger,
				);
				return JSON.stringify(
					{
						exitCode: result.exitCode,
						success: result.success,
						stdout: truncate(result.stdout),
						stderr: truncate(result.stderr),
					},
					null,
					2,
				);
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				logger.error('run_command failed', { error: message });
				return JSON.stringify({
					error: `run_command failed: ${message}`,
					hint: isTransientSandboxError(message)
						? 'The sandbox container was still cold-starting. Try the command again.'
						: undefined,
				});
			}
		},
	});

	return { run_command } as unknown as ToolSet;
}
