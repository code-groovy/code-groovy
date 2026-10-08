import * as path from 'path';
import * as fs from 'fs';
import Mocha from 'mocha';

export function run(): Promise<void> {
	const startedMarker = process.env.CODE_GROOVY_SUITE_STARTED;
	if (startedMarker) {
		fs.writeFileSync(startedMarker, '');
	}

	const mocha = new Mocha({
		ui: 'tdd',
		color: true
	});

	const testsRoot = path.resolve(__dirname, '..');
	const files = fs.readdirSync(testsRoot, { recursive: true, encoding: 'utf8' })
		.filter((file: string) => file.endsWith('.test.js'));

	for (const file of files) {
		mocha.addFile(path.resolve(testsRoot, file));
	}

	return new Promise((resolve, reject) => {
		mocha.run((failures: number) => {
			if (failures > 0) {
				reject(new Error(`${failures} tests failed.`));
			} else {
				resolve();
			}
		});
	});
}
