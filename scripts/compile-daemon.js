'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const source = path.join(root, 'compiler', 'CompilerDaemon.java');
const out = path.join(root, 'out', 'compiler');
fs.mkdirSync(out, { recursive: true });

const javacName = process.platform === 'win32' ? 'javac.exe' : 'javac';
const fromHome = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', javacName) : '';
const javac = fromHome && fs.existsSync(fromHome) ? fromHome : javacName;
const version = spawnSync(javac, ['-version'], { encoding: 'utf8' });
const versionText = `${version.stdout || ''}${version.stderr || ''}`;
const modern = versionText.match(/javac (\d+)\./);
const legacy = versionText.match(/javac 1\.(\d+)/);
const major = modern && Number(modern[1]) > 1 ? Number(modern[1]) : (legacy ? Number(legacy[1]) : 0);
const releaseArgs = major >= 9 ? ['--release', '8'] : ['-source', '8', '-target', '8'];

const result = spawnSync(javac, [...releaseArgs, '-encoding', 'UTF-8', '-d', out, source], {
	stdio: 'inherit'
});

if (result.error) {
	console.error(result.error.message);
	process.exit(1);
}

process.exit(result.status === null ? 1 : result.status);
