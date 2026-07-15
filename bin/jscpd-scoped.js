#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { version } = require('../package.json');

const USAGE = `Usage:
  jscpd-scoped full [--] [paths...]
  jscpd-scoped pr --base <commit> [--] [paths...]
  jscpd-scoped --version`;

class CliError extends Error {}

function execute(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  });
  if (result.error) throw new CliError(`${command} failed: ${result.error.message}`);
  return result;
}

function parseArguments(argv) {
  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-V')) {
    return { version: true };
  }

  const [mode, ...rest] = argv;
  if (mode !== 'full' && mode !== 'pr') throw new CliError(USAGE);

  let base;
  const paths = [];
  let positionalOnly = false;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (!positionalOnly && argument === '--') {
      positionalOnly = true;
    } else if (!positionalOnly && argument === '--base' && mode === 'pr') {
      if (base !== undefined || index + 1 >= rest.length) throw new CliError(USAGE);
      base = rest[index + 1];
      index += 1;
    } else if (!positionalOnly && argument.startsWith('-')) {
      throw new CliError(USAGE);
    } else {
      paths.push(argument);
    }
  }

  if (mode === 'pr' && !base) throw new CliError(USAGE);
  return { mode, base, paths: paths.length > 0 ? paths : ['.'] };
}

function git(repoRoot, args) {
  const result = execute('git', args, repoRoot);
  if (result.status !== 0) {
    throw new CliError(result.stderr.trim() || `git ${args[0]} failed with exit ${result.status}`);
  }
  return result.stdout;
}

function repositoryRoot(cwd) {
  const result = execute('git', ['rev-parse', '--show-toplevel'], cwd);
  if (result.status !== 0) throw new CliError('PR mode must run inside a Git repository.');
  return fs.realpathSync(path.resolve(result.stdout.trim()));
}

function requireCleanWorktree(repoRoot) {
  const status = git(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status.length > 0) {
    throw new CliError('PR mode requires a clean worktree so the scan matches committed HEAD.');
  }
}

function resolveBase(repoRoot, base) {
  const result = execute(
    'git',
    ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`],
    repoRoot
  );
  if (result.status !== 0) {
    throw new CliError(
      `Base commit "${base}" is unavailable. Fetch full history (for GitHub Actions, use fetch-depth: 0).`
    );
  }
  return result.stdout.trim();
}

function repositoryPath(root, absolute, errorMessage) {
  const relative = path.relative(root, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new CliError(errorMessage);
  }
  return relative === '' ? '.' : relative.split(path.sep).join('/');
}

function normalizeScanPaths(root, cwd, inputs) {
  return inputs.map((input) => {
    let absolute;
    try {
      absolute = fs.realpathSync(path.resolve(cwd, input));
    } catch (error) {
      throw new CliError(`Unable to access scan path "${input}": ${error.message}`);
    }
    return {
      absolute,
      git: repositoryPath(root, absolute, `Scan path resolves outside the repository: ${input}`),
    };
  });
}

function decodeGitPath(raw) {
  if (!raw.startsWith('"')) return raw;
  let closingQuote = raw.length - 1;
  while (closingQuote > 0 && raw[closingQuote] !== '"') closingQuote -= 1;
  if (closingQuote === 0 || raw.slice(closingQuote + 1).trim() !== '') {
    throw new CliError(`Invalid quoted Git path: ${raw}`);
  }

  let decoded = '';
  for (let index = 1; index < closingQuote; index += 1) {
    const character = raw[index];
    if (character !== '\\') {
      decoded += character;
      continue;
    }

    index += 1;
    const escaped = raw[index];
    const simple = { b: '\b', n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };
    if (Object.prototype.hasOwnProperty.call(simple, escaped)) {
      decoded += simple[escaped];
      continue;
    }
    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      while (octal.length < 3 && /[0-7]/.test(raw[index + 1])) {
        index += 1;
        octal += raw[index];
      }
      decoded += String.fromCharCode(Number.parseInt(octal, 8));
      continue;
    }
    throw new CliError(`Unsupported escape in Git path: \\${escaped}`);
  }
  return decoded;
}

function validateConfig(root) {
  const configPath = path.join(root, '.jscpd.json');
  let contents;
  try {
    contents = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw new CliError(`Unable to read .jscpd.json: ${error.message}`);
  }
  try {
    const config = JSON.parse(contents);
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('expected an object');
  } catch (error) {
    throw new CliError(`Invalid .jscpd.json: ${error.message}`);
  }
}

function parseChangedLines(patch) {
  const changed = new Map();
  let currentPath;

  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ ')) {
      const decoded = decodeGitPath(line.slice(4));
      currentPath = decoded === '/dev/null' ? undefined : decoded.replace(/^b\//, '');
      continue;
    }
    if (!currentPath || !line.startsWith('@@ ')) continue;

    const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!match) throw new CliError(`Unable to parse Git diff hunk: ${line}`);
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count === 0) continue;
    const ranges = changed.get(currentPath) || [];
    ranges.push({ start, end: start + count - 1 });
    changed.set(currentPath, ranges);
  }

  return changed;
}

function changedLines(repoRoot, base, scanPaths) {
  const patch = git(repoRoot, [
    '-c',
    'core.quotePath=false',
    'diff',
    '--unified=0',
    '--no-color',
    '--no-ext-diff',
    '--find-renames',
    `${base}...HEAD`,
    '--',
    ...scanPaths.map((scanPath) => scanPath.git),
  ]);
  return parseChangedLines(patch);
}

function validateEndpoint(endpoint) {
  return Boolean(
    endpoint &&
      typeof endpoint === 'object' &&
      typeof endpoint.name === 'string' &&
      endpoint.name.length > 0 &&
      Number.isInteger(endpoint.start) &&
      Number.isInteger(endpoint.end) &&
      endpoint.start > 0 &&
      endpoint.end >= endpoint.start
  );
}

function validateReport(report) {
  if (!report || typeof report !== 'object' || !Array.isArray(report.duplicates)) {
    throw new CliError('Invalid jscpd report: "duplicates" must be an array.');
  }
  if (
    report.duplicates.some(
      (duplicate) =>
        !duplicate ||
        typeof duplicate !== 'object' ||
        !validateEndpoint(duplicate.firstFile) ||
        !validateEndpoint(duplicate.secondFile)
    )
  ) {
    throw new CliError('Invalid jscpd report: each duplicate must have two valid endpoints.');
  }
  return report.duplicates;
}

function reportedSourcePath(root, endpointName, format) {
  const reported = path.resolve(root, endpointName);
  const suffix = typeof format === 'string' ? `:${format}` : '';
  let compositeError;
  if (suffix && endpointName.endsWith(suffix)) {
    try {
      return fs.realpathSync(path.resolve(root, endpointName.slice(0, -suffix.length)));
    } catch (error) {
      compositeError = error;
    }
  }

  try {
    return fs.realpathSync(reported);
  } catch (reportedError) {
    const detail = compositeError
      ? `${reportedError.message}; source path: ${compositeError.message}`
      : reportedError.message;
    throw new CliError(`jscpd reported an unavailable file: ${endpointName} (${detail})`);
  }
}

function normalizeEndpoint(root, endpoint, format) {
  const absolute = reportedSourcePath(root, endpoint.name, format);
  const relative = repositoryPath(
    root,
    absolute,
    `jscpd reported a file outside the repository: ${endpoint.name}`
  );
  return { ...endpoint, path: relative };
}

function scan(root, scanPaths) {
  const reportDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'jscpd-scoped-'));
  const reportPath = path.join(reportDirectory, 'jscpd-report.json');

  try {
    const runner = require.resolve('jscpd/run-jscpd.js');
    const result = execute(
      process.execPath,
      [
        runner,
        '--reporters',
        'json',
        '--output',
        reportDirectory,
        '--exit-code',
        '0',
        '--threshold',
        '100',
        '--absolute',
        '--silent',
        '--no-colors',
        '--no-tips',
        '--',
        ...scanPaths.map((scanPath) => scanPath.absolute),
      ],
      root
    );
    if (result.status !== 0) {
      throw new CliError(
        `jscpd failed with exit ${result.status}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`
      );
    }
    let report;
    try {
      report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    } catch (error) {
      const message = error.code === 'ENOENT' ? 'jscpd did not produce its JSON report.' : error.message;
      throw new CliError(`Unable to read jscpd JSON report: ${message}`);
    }
    return validateReport(report).map((duplicate) => ({
      ...duplicate,
      firstFile: normalizeEndpoint(root, duplicate.firstFile, duplicate.format),
      secondFile: normalizeEndpoint(root, duplicate.secondFile, duplicate.format),
    }));
  } finally {
    try {
      fs.rmSync(reportDirectory, { recursive: true, force: true });
    } catch (error) {
      console.error(`[jscpd-scoped] warning: unable to remove temporary report: ${error.message}`);
    }
  }
}

function endpointIntersects(endpoint, changed) {
  const ranges = changed.get(endpoint.path) || [];
  return ranges.some((range) => endpoint.start <= range.end && endpoint.end >= range.start);
}

function printFindings(mode, findings, changed) {
  console.log(`[jscpd-scoped] ${mode}: found ${findings.length} duplicate${findings.length === 1 ? '' : 's'}.`);
  for (const finding of findings) {
    const first = `${finding.firstFile.path}:${finding.firstFile.start}-${finding.firstFile.end}`;
    const second = `${finding.secondFile.path}:${finding.secondFile.start}-${finding.secondFile.end}`;
    const size = [finding.lines && `${finding.lines} lines`, finding.tokens && `${finding.tokens} tokens`]
      .filter(Boolean)
      .join(', ');
    console.log(`- ${first} <-> ${second}${size ? ` (${size})` : ''}`);
    if (mode === 'pr') {
      const touched = [finding.firstFile, finding.secondFile]
        .filter((endpoint) => endpointIntersects(endpoint, changed))
        .map((endpoint) => endpoint.path);
      console.log(`  changed lines overlap ${touched.join(', ')}`);
    }
  }
}

function run(argv = process.argv.slice(2), cwd = process.cwd()) {
  try {
    const options = parseArguments(argv);
    if (options.version) {
      console.log(version);
      return 0;
    }

    const root = options.mode === 'pr' ? repositoryRoot(cwd) : fs.realpathSync(path.resolve(cwd));
    const scanPaths = normalizeScanPaths(root, cwd, options.paths);
    validateConfig(root);
    let changed;
    if (options.mode === 'pr') {
      requireCleanWorktree(root);
      const base = resolveBase(root, options.base);
      changed = changedLines(root, base, scanPaths);
    }

    const allFindings = scan(root, scanPaths);
    const findings =
      options.mode === 'full'
        ? allFindings
        : allFindings.filter(
            (finding) =>
              endpointIntersects(finding.firstFile, changed) ||
              endpointIntersects(finding.secondFile, changed)
          );

    if (findings.length === 0) {
      const ignored = options.mode === 'pr' ? ` (${allFindings.length} existing finding${allFindings.length === 1 ? '' : 's'} ignored)` : '';
      console.log(`[jscpd-scoped] ${options.mode} passed${ignored}.`);
      return 0;
    }

    printFindings(options.mode, findings, changed);
    return 1;
  } catch (error) {
    console.error(`[jscpd-scoped] ${error.message}`);
    return 2;
  }
}

if (require.main === module) process.exitCode = run();

module.exports = { decodeGitPath, parseChangedLines, run, validateReport };
