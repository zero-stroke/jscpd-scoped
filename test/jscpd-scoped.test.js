const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { after, test } = require('node:test');

const BIN = path.resolve(__dirname, '../bin/jscpd-scoped.js');
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

function initRepo(name, config = {}) {
  const repo = path.join(ROOT, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test User');
  write(
    repo,
    '.jscpd.json',
    `${JSON.stringify({ minLines: 3, minTokens: 10, formats: ['javascript'], ...config }, null, 2)}\n`
  );
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

  write(
    repo,
    '.jscpd.json',
    `${JSON.stringify({ minLines: 3, minTokens: 10, formats: ['javascript'], threshold: 0 }, null, 2)}\n`
  );
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
