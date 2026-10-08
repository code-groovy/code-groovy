import * as fs from 'fs';
import * as path from 'path';

import { runTests, TestRunFailedError } from '@vscode/test-electron';

const MAX_ATTEMPTS = 3;

async function main() {
	// Cursor/VS Code set this when the integrated terminal is an Electron child.
	// If inherited, the downloaded Code binary runs as Node and rejects Electron flags.
	delete process.env.ELECTRON_RUN_AS_NODE;

	const extensionDevelopmentPath = path.resolve(__dirname, '../../');
	const extensionTestsPath = path.resolve(__dirname, './suite/index');

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const userDataDir = path.join(extensionDevelopmentPath, '.vscode-test', `user-data-${attempt}`);
		const startedMarker = path.join(extensionDevelopmentPath, '.vscode-test', `suite-started-${attempt}`);
		fs.rmSync(userDataDir, { recursive: true, force: true });
		fs.rmSync(startedMarker, { force: true });
		try {
			await runTests({
				extensionDevelopmentPath,
				extensionTestsPath,
				extensionTestsEnv: { CODE_GROOVY_SUITE_STARTED: startedMarker },
				launchArgs: ['--disable-gpu', `--user-data-dir=${userDataDir}`]
			});
			return;
		} catch (err) {
			console.error(`Integration tests attempt ${attempt}/${MAX_ATTEMPTS} failed: ${err instanceof Error ? err.message : String(err)}`);
			if ((err instanceof TestRunFailedError && err.signal) || fs.existsSync(startedMarker)) {
				break;
			}
		}
	}

	console.error('Failed to run tests');
	process.exit(1);
}

main();
