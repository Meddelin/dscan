import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

export class GitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function run(
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL');
          rejectPromise(
            new GitError(
              `git ${args.join(' ')} timed out after ${opts.timeoutMs}ms`,
              -1,
              stderr,
            ),
          );
        }, opts.timeoutMs)
      : null;

    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      rejectPromise(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ stdout, stderr, code: code ?? -1 });
    });
  });
}

export async function gitClone(
  url: string,
  dest: string,
  opts: { depth?: number; branch?: string; singleBranch?: boolean } = {},
): Promise<void> {
  const args = ['clone'];
  if (opts.depth !== undefined) args.push('--depth', String(opts.depth));
  if (opts.singleBranch) args.push('--single-branch');
  if (opts.branch) args.push('--branch', opts.branch);
  args.push('--', url, dest);

  const result = await run(args, { timeoutMs: 180_000 });
  if (result.code !== 0) {
    // Fail-fast, no retry (PRD §8.3): bubble up stderr as-is.
    throw new GitError(
      `git clone failed for ${url}`,
      result.code,
      result.stderr,
    );
  }
}

/**
 * Returns either a tag (preferred) or a short SHA (fallback). §8.1.
 */
export async function gitDescribe(repoPath: string): Promise<string> {
  const result = await run(['describe', '--tags', '--always'], {
    cwd: repoPath,
    timeoutMs: 10_000,
  });
  if (result.code !== 0) {
    throw new GitError(
      `git describe failed in ${repoPath}`,
      result.code,
      result.stderr,
    );
  }
  return result.stdout.trim();
}

export async function gitPull(repoPath: string): Promise<void> {
  const result = await run(['pull', '--ff-only'], {
    cwd: repoPath,
    timeoutMs: 60_000,
  });
  if (result.code !== 0) {
    throw new GitError(
      `git pull failed in ${repoPath}`,
      result.code,
      result.stderr,
    );
  }
}

export async function isGitRepo(path: string): Promise<boolean> {
  try {
    await access(join(path, '.git'));
    return true;
  } catch {
    return false;
  }
}
