#!/usr/bin/env node
/**
 * Clone every repo in `repositories.json` into `./ds-projects/<name>/`.
 * Idempotent: existing clones are left alone (use `npm run clone:fresh` to wipe
 * first). Fail-fast per PRD §8.3 — first clone error stops the run.
 *
 * Usage:
 *   node scripts/clone-repos.mjs                  # default repositories.json
 *   node scripts/clone-repos.mjs --file other.json
 *   node scripts/clone-repos.mjs --dest .cache/repos
 *
 * Requires SSH access to every gitUrl. If you skipped Keychain on macOS or
 * Windows Credential Manager, load the key into the agent first:
 *
 *   ssh-add ~/.ssh/id_ed25519
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { argv, exit, cwd } from 'node:process';

function parseArgs() {
  const args = { file: 'repositories.json', dest: 'ds-projects', depth: 1 };
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--file' && next) {
      args.file = next;
      i++;
    } else if (flag === '--dest' && next) {
      args.dest = next;
      i++;
    } else if (flag === '--depth' && next) {
      args.depth = Number(next);
      i++;
    } else if (flag === '--full') {
      args.depth = 0;
    } else if (flag === '-h' || flag === '--help') {
      process.stdout.write(
        'Usage: node scripts/clone-repos.mjs [--file repositories.json] [--dest ds-projects] [--depth 1|--full]\n',
      );
      exit(0);
    }
  }
  return args;
}

function run(cmd, args, opts) {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      windowsHide: true,
      ...opts,
    });
    child.on('error', rejectP);
    child.on('close', (code) =>
      code === 0 ? resolveP(undefined) : rejectP(new Error(`${cmd} ${args.join(' ')} failed (exit ${code})`)),
    );
  });
}

async function isDir(p) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs();
  const filePath = resolve(cwd(), args.file);
  const destDir = resolve(cwd(), args.dest);

  const text = await readFile(filePath, 'utf-8').catch((err) => {
    process.stderr.write(`Cannot read ${filePath}: ${err.message}\n`);
    exit(2);
  });
  const repos = JSON.parse(text);
  if (!Array.isArray(repos) || repos.length === 0) {
    process.stderr.write(`${filePath} must be a non-empty array of repo entries.\n`);
    exit(2);
  }

  await mkdir(destDir, { recursive: true });

  let cloned = 0;
  let skipped = 0;

  for (const repo of repos) {
    if (!repo.gitUrl) {
      process.stderr.write(`Skipping entry without gitUrl: ${JSON.stringify(repo)}\n`);
      continue;
    }
    const name = repo.name ?? deriveName(repo.gitUrl);
    const target = join(destDir, name);
    if (await isDir(join(target, '.git'))) {
      process.stdout.write(`[skip] ${name} already cloned at ${target}\n`);
      skipped++;
      continue;
    }
    process.stdout.write(`[clone] ${name} → ${target}\n`);
    const cloneArgs = ['clone'];
    if (args.depth > 0) cloneArgs.push('--depth', String(args.depth), '--single-branch');
    cloneArgs.push('--', repo.gitUrl, target);
    try {
      await run('git', cloneArgs);
      cloned++;
    } catch (err) {
      process.stderr.write(
        `\nClone failed for ${name}. Common causes:\n` +
          `  • SSH key not loaded — run: ssh-add ~/.ssh/id_ed25519\n` +
          `  • No access to ${repo.gitUrl}\n` +
          `  • Network / VPN to GitLab\n\n${err.message}\n`,
      );
      exit(3);
    }
  }

  process.stdout.write(
    `\nDone: ${cloned} cloned · ${skipped} already present.\n`,
  );
}

function deriveName(gitUrl) {
  const match = /\/([^/]+?)(?:\.git)?$/.exec(gitUrl);
  return match?.[1] ?? gitUrl;
}

main().catch((err) => {
  process.stderr.write(`${err.stack ?? err.message}\n`);
  exit(1);
});
