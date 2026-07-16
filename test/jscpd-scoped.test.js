const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { after, test } = require('node:test');

const BIN = path.resolve(__dirname, '../bin/jscpd-scoped.js');
const FAILURE_PRELOAD = path.resolve(__dirname, '../fixtures/inject-jscpd-failure.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'jscpd-scoped-test-'));

after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: 'utf8' });
}

function git(repo, ...args) {
  const result = run('git', args, repo);
  assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

function write(repo, relativePath, contents) {
  const filePath = path.join(repo, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function writeConfig(repo, config) {
  write(repo, '.jscpd.json', `${JSON.stringify(config, null, 2)}\n`);
}

function initRepo(name, config = {}) {
  const repo = path.join(ROOT, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test User');
  writeConfig(repo, { minLines: 3, minTokens: 10, formats: ['javascript'], ...config });
  return repo;
}

function commit(repo, message) {
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', message);
  return git(repo, 'rev-parse', 'HEAD');
}

function cli(repo, ...args) {
  return run(process.execPath, [BIN, ...args], repo);
}

function cliWithEnv(repo, env, ...args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function cliWithInjectedDetector(repo, failure, ...args) {
  return cliWithEnv(
    repo,
    {
      JSCPD_SCOPED_TEST_FAILURE: failure,
      NODE_OPTIONS: `--require=${FAILURE_PRELOAD}`,
    },
    ...args
  );
}

function assertExit(result, expected, label) {
  assert.equal(
    result.status,
    expected,
    `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
}

function duplicateBlock(increment = 1) {
  return `function sharedCalculation(value) {
  const first = value + ${increment};
  const second = first + 2;
  const third = second + 3;
  return third;
}

module.exports = sharedCalculation;
`;
}

function vueComponent(increment = 1) {
  return `<template><div>fixture</div></template>
<script>
${duplicateBlock(increment)}</script>
`;
}

function differentBlock() {
  return `function unrelatedWorkflow(input) {
  const normalized = String(input).trim();
  const pieces = normalized.split(':');
  const selected = pieces.filter(Boolean);
  return selected.join('/');
}

module.exports = unrelatedWorkflow;
`;
}

function pathsUnder(root) {
  const entries = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      entries.push(path.relative(root, absolute));
      if (entry.isDirectory()) visit(absolute);
    }
  }
  visit(root);
  return entries.sort();
}

test('full mode passes clean code and fails with both duplicate locations', () => {
  const repo = initRepo('full');
  write(repo, 'src/a.js', duplicateBlock());
  commit(repo, 'one file');

  let result = cli(repo, 'full', 'src');
  assertExit(result, 0, 'one file should be clean');

  write(repo, 'src/b.js', duplicateBlock());
  commit(repo, 'duplicate file');
  result = cli(repo, 'full', 'src');
  assertExit(result, 1, 'full mode should reject a duplicate');
  assert.match(result.stdout, /src\/a\.js:\d+-\d+/);
  assert.match(result.stdout, /src\/b\.js:\d+-\d+/);
});

test('pr mode tolerates old duplicates and unrelated edits', () => {
  const repo = initRepo('old-old', { threshold: 0 });
  write(repo, 'src/a.js', duplicateBlock());
  write(repo, 'src/b.js', duplicateBlock());
  const base = commit(repo, 'existing duplicates');

  let result = cli(repo, 'pr', '--base', base, 'src');
  assertExit(result, 0, 'old duplicates should pass');

  fs.appendFileSync(path.join(repo, 'src/a.js'), '\nconst unrelated = true;\n');
  commit(repo, 'unrelated edit');
  result = cli(repo, 'pr', '--base', base, 'src');
  assertExit(result, 0, 'an edit outside the clone should pass');
});

test('pr mode rejects new-to-old and new-to-new duplicates', () => {
  const oldRepo = initRepo('new-old');
  write(oldRepo, 'src/a.js', duplicateBlock());
  const oldBase = commit(oldRepo, 'base');
  write(oldRepo, 'src/b.js', duplicateBlock());
  commit(oldRepo, 'copy old code');

  let result = cli(oldRepo, 'pr', '--base', oldBase, 'src');
  assertExit(result, 1, 'new-to-old duplicate should fail');
  assert.match(result.stdout, /changed lines overlap src\/b\.js/);

  const newRepo = initRepo('new-new');
  write(newRepo, 'README.md', 'base\n');
  const newBase = commit(newRepo, 'base');
  write(newRepo, 'src/a.js', duplicateBlock());
  write(newRepo, 'src/b.js', duplicateBlock());
  commit(newRepo, 'two new copies');

  result = cli(newRepo, 'pr', '--base', newBase, 'src');
  assertExit(result, 1, 'new-to-new duplicate should fail');
});

test('pr mode rejects a changed clone and ignores a pure rename', () => {
  const changedRepo = initRepo('changed-clone');
  write(changedRepo, 'src/a.js', duplicateBlock());
  write(changedRepo, 'src/b.js', duplicateBlock());
  const changedBase = commit(changedRepo, 'base duplicates');
  write(changedRepo, 'src/a.js', duplicateBlock(10));
  write(changedRepo, 'src/b.js', duplicateBlock(10));
  commit(changedRepo, 'change both clones');

  let result = cli(changedRepo, 'pr', '--base', changedBase, 'src');
  assertExit(result, 1, 'changed duplicate endpoints should fail');

  const renameRepo = initRepo('rename');
  write(renameRepo, 'src/a.js', duplicateBlock());
  write(renameRepo, 'src/b.js', duplicateBlock());
  const renameBase = commit(renameRepo, 'base duplicates');
  git(renameRepo, 'mv', 'src/a.js', 'src/renamed.js');
  commit(renameRepo, 'rename only');

  result = cli(renameRepo, 'pr', '--base', renameBase, 'src');
  assertExit(result, 0, 'pure rename should pass');
});

test('pr mode ignores deletion-only hunks outside duplicate endpoints', () => {
  const repo = initRepo('deletion-only');
  write(repo, 'src/a.js', `// removable header\n${duplicateBlock()}`);
  write(repo, 'src/b.js', duplicateBlock());
  const base = commit(repo, 'base duplicates');
  write(repo, 'src/a.js', duplicateBlock());
  commit(repo, 'delete unrelated header');

  const result = cli(repo, 'pr', '--base', base, 'src');
  assertExit(result, 0, 'a deletion-only hunk must not claim unchanged duplicate lines');
});

test('pr mode fails closed for dirty worktrees and missing bases', () => {
  const repo = initRepo('fail-closed');
  write(repo, 'src/a.js', duplicateBlock());
  const base = commit(repo, 'base');
  write(repo, 'dirty.js', 'const dirty = true;\n');

  let result = cli(repo, 'pr', '--base', base, 'src');
  assertExit(result, 2, 'dirty worktree should be an operational error');
  assert.match(result.stderr, /clean worktree/i);

  fs.rmSync(path.join(repo, 'dirty.js'));
  result = cli(repo, 'pr', '--base', 'missing-commit', 'src');
  assertExit(result, 2, 'missing base should be an operational error');
  assert.match(result.stderr, /base commit/i);
});

test('native detector settings remain effective while global threshold is neutralized', () => {
  const repo = initRepo('config', { minLines: 100, threshold: 0 });
  write(repo, 'src/a.js', duplicateBlock());
  write(repo, 'src/b.js', duplicateBlock());
  commit(repo, 'high threshold');

  let result = cli(repo, 'full', 'src');
  assertExit(result, 0, 'native minLines should suppress the finding');

  writeConfig(repo, {
    minLines: 3,
    minTokens: 10,
    formats: ['javascript'],
    threshold: 0,
  });
  commit(repo, 'lower detector threshold');
  result = cli(repo, 'full', 'src');
  assertExit(result, 1, 'native minLines should expose the finding');
});

test('paths with shell syntax, spaces, unicode, and tabs stay literal', () => {
  const repo = initRepo('hostile-paths');
  write(repo, 'README.md', 'base\n');
  const base = commit(repo, 'base');
  const directory = 'src;touch SHOULD_NOT_EXIST';
  write(repo, `${directory}/old file.js`, duplicateBlock());
  write(repo, `${directory}/é\tcopy.js`, duplicateBlock());
  commit(repo, 'hostile-looking paths');

  const result = cli(repo, 'pr', '--base', base, directory);
  assertExit(result, 1, 'literal unusual paths should be scanned and matched');
  assert.match(result.stdout, /é\tcopy\.js/);
  assert.doesNotMatch(result.stderr, /MODULE_NOT_FOUND/);
  assert.equal(fs.existsSync(path.join(repo, 'SHOULD_NOT_EXIST')), false);
});

test('pr mode maps Vue composite report paths back to source files', () => {
  const repo = initRepo('vue-paths', {
    formats: ['vue'],
    ignorePattern: ['(?s)<template[^>]*>.*</template>'],
  });
  write(repo, 'src/a.vue', vueComponent());
  const base = commit(repo, 'base');
  write(repo, 'src/b.vue', vueComponent());
  commit(repo, 'copy Vue script');

  const result = cli(repo, 'pr', '--base', base, 'src');
  assertExit(result, 1, 'a changed Vue endpoint should match its Git source path');
  assert.match(result.stdout, /src\/b\.vue:\d+-\d+/);
  assert.doesNotMatch(result.stdout, /\.vue:javascript/);
});

test('malformed config and report structures fail closed', () => {
  const repo = initRepo('invalid-config');
  write(repo, 'src/a.js', duplicateBlock());
  commit(repo, 'base');
  write(repo, '.jscpd.json', '{bad json\n');

  const result = cli(repo, 'full', 'src');
  assertExit(result, 2, 'invalid jscpd config should fail closed');

  const { validateReport } = require(BIN);
  assert.throws(() => validateReport({}), /duplicates.*array/i);
  assert.throws(
    () => validateReport({ duplicates: [{ firstFile: {}, secondFile: {} }] }),
    /two valid endpoints/i
  );
});

test('missing and out-of-repository scan paths fail closed', () => {
  const repo = initRepo('invalid-scan-paths');
  write(repo, 'src/a.js', duplicateBlock());
  commit(repo, 'base');

  let result = cli(repo, 'full', 'missing');
  assertExit(result, 2, 'a missing scan path must not produce a false pass');
  assert.match(result.stderr, /unable to access scan path/i);

  const outside = path.join(ROOT, 'outside-scan-path');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(repo, 'outside-link'));
  result = cli(repo, 'full', 'outside-link');
  assertExit(result, 2, 'a symlink outside the repository must fail closed');
  assert.match(result.stderr, /resolves outside the repository/i);
});

test('version and invalid invocation have stable exits', () => {
  let result = cli(ROOT, '--version');
  assertExit(result, 0, 'version should succeed');
  assert.equal(result.stdout.trim(), '0.1.0');

  result = cli(ROOT, 'pr', 'src');
  assertExit(result, 2, 'missing base should fail');
  assert.match(result.stderr, /Usage:/);
});

test('full mode defaults to the current directory and scans uncommitted code', () => {
  const repo = initRepo('full-default-worktree');
  write(repo, 'src/a.js', duplicateBlock());
  commit(repo, 'base');
  write(repo, 'src/b.js', duplicateBlock());

  const result = cli(repo, 'full');
  assertExit(result, 1, 'full mode should scan the current worktree without requiring a commit');
  assert.match(result.stdout, /src\/a\.js:\d+-\d+/);
  assert.match(result.stdout, /src\/b\.js:\d+-\d+/);
});

test('full mode detects same-file clones and prints size metadata', () => {
  const repo = initRepo('same-file');
  write(repo, 'src/repeated.js', `${duplicateBlock()}\n${duplicateBlock()}`);

  const result = cli(repo, 'full', 'src');
  assertExit(result, 1, 'same-file duplication should fail full mode');
  assert.match(result.stdout, /src\/repeated\.js:\d+-\d+ <-> src\/repeated\.js:\d+-\d+/);
  assert.match(result.stdout, /\(\d+ lines, \d+ tokens\)/);
});

test('full mode scans multiple explicit paths and ignores code outside them', () => {
  const repo = initRepo('multiple-paths');
  write(repo, 'src/a.js', duplicateBlock());
  write(repo, 'lib/b.js', duplicateBlock());
  write(repo, 'ignored/c.js', duplicateBlock());

  let result = cli(repo, 'full', 'src');
  assertExit(result, 0, 'one selected path should not compare against unscanned files');

  result = cli(repo, 'full', 'src', 'lib');
  assertExit(result, 1, 'duplicates across selected paths should fail');
  assert.doesNotMatch(result.stdout, /ignored\/c\.js/);
});

test('similar but distinct blocks do not produce a finding', () => {
  const repo = initRepo('distinct-code');
  write(repo, 'src/a.js', duplicateBlock());
  write(repo, 'src/b.js', differentBlock());

  const result = cli(repo, 'full', 'src');
  assertExit(result, 0, 'structurally different code should pass');
});

test('native minTokens, formats, and ignore settings remain effective', () => {
  const tokenRepo = initRepo('config-min-tokens', { minTokens: 1000 });
  write(tokenRepo, 'src/a.js', duplicateBlock());
  write(tokenRepo, 'src/b.js', duplicateBlock());
  let result = cli(tokenRepo, 'full', 'src');
  assertExit(result, 0, 'native minTokens should suppress a small clone');

  const formatRepo = initRepo('config-formats', { formats: ['typescript'] });
  write(formatRepo, 'src/a.js', duplicateBlock());
  write(formatRepo, 'src/b.js', duplicateBlock());
  result = cli(formatRepo, 'full', 'src');
  assertExit(result, 0, 'files outside configured formats should be ignored');

  const ignoreRepo = initRepo('config-ignore', { ignore: ['**/generated/**'] });
  write(ignoreRepo, 'src/generated/a.js', duplicateBlock());
  write(ignoreRepo, 'src/generated/b.js', duplicateBlock());
  result = cli(ignoreRepo, 'full', 'src');
  assertExit(result, 0, 'native ignore globs should exclude generated code');
});

test('every invocation is fresh and creates no cache, session, or suppression state', () => {
  const repo = initRepo('stateless');
  write(repo, 'src/a.js', duplicateBlock());
  write(repo, 'src/b.js', duplicateBlock());
  const before = pathsUnder(repo);

  let result = cli(repo, 'full', 'src');
  assertExit(result, 1, 'initial duplicate should fail');
  assert.deepEqual(pathsUnder(repo), before);

  write(repo, 'src/b.js', differentBlock());
  result = cli(repo, 'full', 'src');
  assertExit(result, 0, 'the next invocation must rescan instead of serving stale state');
  assert.deepEqual(pathsUnder(repo), before);
});

for (const [label, args] of [
  ['empty invocation', []],
  ['unknown mode', ['scan', 'src']],
  ['unknown option', ['full', '--unknown', 'src']],
  ['full-mode base option', ['full', '--base', 'HEAD', 'src']],
  ['duplicate base option', ['pr', '--base', 'HEAD', '--base', 'HEAD', 'src']],
  ['session command', ['session', 'current']],
  ['mark command', ['mark', 'clone-id', 'preexisting']],
  ['suppression option', ['full', '--no-suppress', 'src']],
]) {
  test(`${label} is rejected with the tool-error contract`, () => {
    const result = cli(ROOT, ...args);
    assertExit(result, 2, `${label} should be rejected`);
    assert.match(result.stderr, /Usage:/);
  });
}

test('dash-prefixed paths remain positional after the option terminator', () => {
  const repo = initRepo('dash-path');
  write(repo, '-src/a.js', duplicateBlock());
  write(repo, '-src/b.js', duplicateBlock());

  const result = cli(repo, 'full', '--', '-src');
  assertExit(result, 1, 'a dash-prefixed directory should be scanned literally');
  assert.match(result.stdout, /-src\/a\.js/);
});

test('base refs containing shell syntax remain literal', () => {
  const repo = initRepo('hostile-base');
  write(repo, 'src/a.js', duplicateBlock());
  commit(repo, 'base');
  const marker = path.join(repo, 'BASE_COMMAND_EXECUTED');

  const result = cli(repo, 'pr', '--base', '$(touch BASE_COMMAND_EXECUTED)', 'src');
  assertExit(result, 2, 'an invalid hostile-looking base should fail as data');
  assert.equal(fs.existsSync(marker), false);
});

test('PR mode fails closed outside a Git repository', () => {
  const directory = path.join(ROOT, 'not-a-repository');
  fs.mkdirSync(directory);
  write(directory, 'a.js', duplicateBlock());

  const result = cli(directory, 'pr', '--base', 'HEAD', '.');
  assertExit(result, 2, 'PR mode requires Git metadata');
  assert.match(result.stderr, /inside a Git repository/i);
});

for (const [state, mutate] of [
  [
    'unstaged',
    (repo) => fs.appendFileSync(path.join(repo, 'src/a.js'), '\nconst dirty = true;\n'),
  ],
  [
    'staged',
    (repo) => {
      write(repo, 'staged.js', 'const dirty = true;\n');
      git(repo, 'add', 'staged.js');
    },
  ],
]) {
  test(`PR mode rejects a ${state} worktree`, () => {
    const repo = initRepo(`dirty-${state}`);
    write(repo, 'src/a.js', duplicateBlock());
    const base = commit(repo, 'base');
    mutate(repo);

    const result = cli(repo, 'pr', '--base', base, 'src');
    assertExit(result, 2, `${state} changes must not be omitted from PR scope`);
    assert.match(result.stderr, /clean worktree/i);
  });
}

test('PR mode detects a rename that also changes duplicate lines', () => {
  const repo = initRepo('rename-with-edit');
  write(repo, 'src/a.js', duplicateBlock());
  write(repo, 'src/b.js', duplicateBlock());
  const base = commit(repo, 'base duplicates');
  git(repo, 'mv', 'src/a.js', 'src/renamed.js');
  fs.appendFileSync(path.join(repo, 'src/renamed.js'), '\nconst changed = true;\n');
  commit(repo, 'rename and edit');

  const result = cli(repo, 'pr', '--base', base, 'src');
  assertExit(result, 0, 'an edit outside the renamed duplicate range should pass');

  const changedRepo = initRepo('rename-inside-clone');
  write(changedRepo, 'src/a.js', duplicateBlock());
  write(changedRepo, 'src/b.js', duplicateBlock());
  const changedBase = commit(changedRepo, 'base duplicates');
  git(changedRepo, 'mv', 'src/a.js', 'src/renamed.js');
  write(changedRepo, 'src/renamed.js', duplicateBlock(9));
  write(changedRepo, 'src/b.js', duplicateBlock(9));
  commit(changedRepo, 'rename and change clone');

  const changedResult = cli(changedRepo, 'pr', '--base', changedBase, 'src');
  assertExit(changedResult, 1, 'changed duplicate lines in a renamed file should fail');
  assert.match(changedResult.stdout, /src\/renamed\.js/);
});

test('PR mode scopes changed lines to the selected scan paths', () => {
  const repo = initRepo('pr-path-scope');
  write(repo, 'src/a.js', duplicateBlock());
  write(repo, 'src/b.js', duplicateBlock());
  const base = commit(repo, 'base duplicates');
  write(repo, 'outside/new.js', duplicateBlock());
  commit(repo, 'change outside selected scope');

  const result = cli(repo, 'pr', '--base', base, 'src');
  assertExit(result, 0, 'changes outside selected paths must not activate old findings');
});

test('PR mode handles quoted newline paths', () => {
  const repo = initRepo('newline-path');
  write(repo, 'README.md', 'base\n');
  const base = commit(repo, 'base');
  write(repo, 'src/old.js', duplicateBlock());
  write(repo, 'src/new\ncopy.js', duplicateBlock());
  commit(repo, 'newline filename');

  const result = cli(repo, 'pr', '--base', base, 'src');
  assertExit(result, 1, 'a newline-containing Git path should map to its scanner endpoint');
  assert.match(result.stdout, /src\/new\ncopy\.js/);
});

test('real filenames ending with a format suffix are not mistaken for composite paths', () => {
  const repo = initRepo('real-format-suffix');
  write(repo, 'src/repeated.js:javascript', duplicateBlock());
  write(repo, 'src/other.js', duplicateBlock());

  const result = cliWithInjectedDetector(repo, 'synthetic-report', 'full', 'src');
  assertExit(result, 1, 'a real format-suffixed file should be reported as itself');
  assert.match(result.stdout, /src\/repeated\.js:javascript:\d+-\d+/);
  assert.match(result.stdout, /src\/other\.js:\d+-\d+/);
});

test('format-suffixed report paths fail closed when exact and composite sources both exist', () => {
  const repo = initRepo('ambiguous-format-suffix');
  write(repo, 'src/repeated.js', differentBlock());
  write(repo, 'src/repeated.js:javascript', duplicateBlock());
  write(repo, 'src/other.js', duplicateBlock());

  const result = cliWithInjectedDetector(repo, 'synthetic-report', 'full', 'src');
  assertExit(result, 2, 'ambiguous detector provenance should not be guessed');
  assert.match(result.stderr, /both the exact path and composite source exist/);
});

test('detector execution and missing-report failures are operational errors', () => {
  const repo = initRepo('detector-failures');
  write(repo, 'src/a.js', duplicateBlock());

  let result = cliWithInjectedDetector(repo, 'process', 'full', 'src');
  assertExit(result, 2, 'a detector process failure should fail closed');
  assert.match(result.stderr, /jscpd failed with exit 9: synthetic detector failure/);

  result = cliWithInjectedDetector(repo, 'missing-report', 'full', 'src');
  assertExit(result, 2, 'a missing detector report should fail closed');
  assert.match(result.stderr, /jscpd did not produce its JSON report/);

  result = cliWithInjectedDetector(repo, 'synthetic-report', 'full', 'src');
  assertExit(result, 2, 'an unavailable path in a detector report should fail closed');
  assert.match(result.stderr, /jscpd reported an unavailable file/);
});

test('an internal symlinked scan path resolves deterministically', () => {
  const repo = initRepo('internal-symlink');
  write(repo, 'src/real/a.js', duplicateBlock());
  write(repo, 'src/real/b.js', duplicateBlock());
  fs.symlinkSync('real', path.join(repo, 'src/link'));

  const result = cli(repo, 'full', 'src/link');
  assertExit(result, 1, 'an internal symlink should scan its canonical repository target');
  assert.match(result.stdout, /src\/real\/a\.js/);
  assert.doesNotMatch(result.stdout, /src\/link/);
});

test('invalid config JSON values fail closed', () => {
  for (const [name, value] of [
    ['null', 'null\n'],
    ['array', '[]\n'],
    ['string', '"config"\n'],
  ]) {
    const repo = initRepo(`invalid-config-${name}`);
    write(repo, 'src/a.js', duplicateBlock());
    write(repo, '.jscpd.json', value);
    const result = cli(repo, 'full', 'src');
    assertExit(result, 2, `${name} config should fail`);
    assert.match(result.stderr, /expected an object/i);
  }
});

test('report validation rejects invalid endpoint ranges and types', () => {
  const { validateReport } = require(BIN);
  const endpoint = { name: 'src/a.js', start: 1, end: 3 };
  for (const invalid of [
    { ...endpoint, name: '' },
    { ...endpoint, start: 0 },
    { ...endpoint, start: 4, end: 3 },
    { ...endpoint, start: 1.5 },
  ]) {
    assert.throws(
      () => validateReport({ duplicates: [{ firstFile: invalid, secondFile: endpoint }] }),
      /two valid endpoints/i
    );
  }
});

test('package metadata pins the public runtime contract', () => {
  const packageJson = require('../package.json');
  assert.deepEqual(packageJson.bin, { 'jscpd-scoped': 'bin/jscpd-scoped.js' });
  assert.deepEqual(packageJson.files, ['bin']);
  assert.equal(packageJson.dependencies.jscpd, '5.0.12');
  assert.equal(packageJson.engines.node, '>=18');
  assert.equal(packageJson.publishConfig.access, 'public');
});
