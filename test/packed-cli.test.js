const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { after, test } = require('node:test');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'jscpd-scoped-packed-test-'));

after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('the packed package installs and performs a real duplicate scan', () => {
  const packed = spawnSync('npm', ['pack', '--silent', '--pack-destination', ROOT], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
  });
  assert.equal(packed.status, 0, packed.stderr);

  const tarball = path.join(ROOT, packed.stdout.trim());
  const installation = path.join(ROOT, 'installation');
  const installed = spawnSync(
    'npm',
    ['install', '--prefix', installation, '--ignore-scripts', '--no-audit', '--no-fund', tarball],
    { encoding: 'utf8' }
  );
  assert.equal(installed.status, 0, installed.stderr);

  const fixture = path.join(ROOT, 'fixture');
  const source = path.join(fixture, 'src');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(
    path.join(fixture, '.jscpd.json'),
    `${JSON.stringify({ minLines: 3, minTokens: 10, formats: ['javascript'] })}\n`
  );
  const duplicate = `function packedDuplicate(value) {
  const first = value + 1;
  const second = first + 2;
  const third = second + 3;
  return third;
}

module.exports = packedDuplicate;
`;
  fs.writeFileSync(path.join(source, 'a.js'), duplicate);
  fs.writeFileSync(path.join(source, 'b.js'), duplicate);

  const bin = path.join(installation, 'node_modules/jscpd-scoped/bin/jscpd-scoped.js');
  const result = spawnSync(process.execPath, [bin, 'full', 'src'], {
    cwd: fixture,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /src\/a\.js:\d+-\d+/);
  assert.match(result.stdout, /src\/b\.js:\d+-\d+/);
});
