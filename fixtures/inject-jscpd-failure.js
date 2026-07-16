const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const originalSpawnSync = childProcess.spawnSync;

childProcess.spawnSync = function spawnSync(command, args, options) {
  if (Array.isArray(args) && args[0]?.endsWith('jscpd/run-jscpd.js')) {
    if (process.env.JSCPD_SCOPED_TEST_FAILURE === 'process') {
      return { status: 9, stdout: '', stderr: 'synthetic detector failure\n' };
    }
    if (process.env.JSCPD_SCOPED_TEST_FAILURE === 'missing-report') {
      return { status: 0, stdout: '', stderr: '' };
    }
    if (process.env.JSCPD_SCOPED_TEST_FAILURE === 'synthetic-report') {
      const outputDirectory = args[args.indexOf('--output') + 1];
      const endpoint = (name) => ({ name: path.resolve(name), start: 1, end: 8 });
      fs.writeFileSync(
        path.join(outputDirectory, 'jscpd-report.json'),
        JSON.stringify({
          duplicates: [
            {
              format: 'javascript',
              lines: 8,
              tokens: 30,
              firstFile: endpoint('src/repeated.js:javascript'),
              secondFile: endpoint('src/other.js'),
            },
          ],
        })
      );
      return { status: 0, stdout: '', stderr: '' };
    }
  }
  return originalSpawnSync(command, args, options);
};
