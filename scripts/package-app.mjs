import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SEMVER_PATTERN = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

function parseSemverTag(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  const match = SEMVER_PATTERN.exec(trimmed);
  return match ? match[1] : null;
}

function readPackageVersion() {
  const pkg = JSON.parse(readFileSync(resolve(ROOT_DIR, 'package.json'), 'utf8'));
  return parseSemverTag(pkg.version) ?? '0.1.0';
}

function runGit(args) {
  try {
    return execFileSync('git', args, {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

export function resolvePackageVersion() {
  const envAppVersion = parseSemverTag(process.env.APP_VERSION);
  if (envAppVersion) {
    return { version: envAppVersion, source: `env APP_VERSION=${process.env.APP_VERSION}` };
  }

  const githubRefName = process.env.GITHUB_REF_NAME;
  const ciTagVersion = parseSemverTag(githubRefName);
  if (ciTagVersion) {
    return { version: ciTagVersion, source: `CI tag ${githubRefName}` };
  }

  // 优先取当前提交可达的最新 v* tag，否则回退按版本号排序的全局最新 v* tag
  const reachableTag = runGit(['describe', '--tags', '--abbrev=0', '--match', 'v*']);
  const reachableVersion = parseSemverTag(reachableTag);
  if (reachableVersion) {
    return { version: reachableVersion, source: `git tag ${reachableTag}` };
  }

  const allTags = runGit(['tag', '--list', 'v*', '--sort=-v:refname'])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const tag of allTags) {
    const ver = parseSemverTag(tag);
    if (ver) {
      return { version: ver, source: `git tag ${tag}` };
    }
  }

  const pkgVersion = readPackageVersion();
  return { version: pkgVersion, source: 'package.json' };
}

function runNodeScript(scriptRelativePath, args, extraEnv = {}) {
  const scriptPath = resolve(ROOT_DIR, scriptRelativePath);
  const res = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
  if (res.error) {
    throw res.error;
  }
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
}

function main() {
  const rawArgs = process.argv.slice(2);
  let targetPlatform = 'win';
  let skipBuild = false;
  const passthroughArgs = [];

  for (const arg of rawArgs) {
    if (arg === '--win' || arg === '--platform=win') {
      targetPlatform = 'win';
    } else if (arg === '--mac' || arg === '--platform=mac') {
      targetPlatform = 'mac';
    } else if (arg === '--skip-build') {
      skipBuild = true;
    } else {
      passthroughArgs.push(arg);
    }
  }

  const { version, source } = resolvePackageVersion();
  console.log(`[package-app] 目标平台: ${targetPlatform} | 版本号: ${version} (来源: ${source})`);

  if (!skipBuild) {
    runNodeScript('node_modules/electron-vite/bin/electron-vite.js', ['build']);
  }

  const builderArgs =
    targetPlatform === 'mac'
      ? ['--mac', 'dmg', '--arm64', '--x64', '--publish', 'never']
      : ['--win', 'zip', '--x64', '--publish', 'never'];

  builderArgs.push(`-c.extraMetadata.version=${version}`, ...passthroughArgs);
  // Windows zip 使用标准 7za -mx=9 压缩，避免 compression=maximum 触发 -mfb=258 -mpass=15 导致 10+ 分钟卡死
  const builderEnv =
    targetPlatform === 'win' && !process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL
      ? { ELECTRON_BUILDER_COMPRESSION_LEVEL: '9' }
      : {};
  runNodeScript('node_modules/electron-builder/cli.js', builderArgs, builderEnv);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
