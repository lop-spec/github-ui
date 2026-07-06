import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logDir = path.join(root, 'logs');
fs.mkdirSync(logDir, { recursive: true });

const stdoutPath = path.join(logDir, 'react-public-supervisor.out.log');
const stderrPath = path.join(logDir, 'react-public-supervisor.err.log');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const build = spawnSync(npmCommand, ['run', 'build'], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true
});

if (build.status !== 0) {
  process.exit(build.status || 1);
}

const stdout = fs.openSync(stdoutPath, 'a');
const stderr = fs.openSync(stderrPath, 'a');
const child = spawn(process.execPath, ['dist/public-tunnel.js'], {
  cwd: root,
  detached: true,
  windowsHide: true,
  stdio: ['ignore', stdout, stderr]
});

fs.closeSync(stdout);
fs.closeSync(stderr);
child.unref();

console.log(`React public supervisor pid=${child.pid}`);
