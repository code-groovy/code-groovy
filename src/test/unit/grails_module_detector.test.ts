import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	collectGrailsModuleSourceFiles,
	collectSourceFilesFromDirectory,
	detectGrailsModules,
	findGrailsMonorepoRoot
} from '../../groovy/grails_module_detector';

function writeFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

function createFixtureMonorepo(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-groovy-modules-'));
	writeFile(path.join(root, 'settings.gradle'), 'include "domain", "web"\n');
	writeFile(
		path.join(root, 'domain', 'grails-app', 'domain', 'com', 'example', 'fixture', 'Widget.groovy'),
		'package com.example.fixture\n\nclass Widget {}\n'
	);
	writeFile(
		path.join(root, 'web', 'grails-app', 'controllers', 'com', 'example', 'fixture', 'WidgetController.groovy'),
		'package com.example.fixture\n\nclass WidgetController {}\n'
	);
	return root;
}

suite('grails_module_detector', () => {
	test('detects domain and web modules from a synthetic monorepo', async () => {
		const root = createFixtureMonorepo();
		try {
			const modules = detectGrailsModules([{ uri: { fsPath: root } }]);
			const names = modules.map(module => module.name);
			assert.ok(names.includes('domain'));
			assert.ok(names.includes('web'));

			const files = await collectGrailsModuleSourceFiles(modules);
			assert.ok(files.length >= 2);
			assert.ok(files.some(file => file.endsWith('WidgetController.groovy')));
			assert.ok(files.some(file => file.endsWith('Widget.groovy')));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('skips Java language server output folders but keeps other bin folders', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-groovy-bin-'));
		try {
			writeFile(path.join(root, 'services', 'Widget.groovy'), 'class Widget {}\n');
			writeFile(path.join(root, 'bin', 'main', 'Widget.groovy'), 'class Widget {}\n');
			writeFile(path.join(root, 'bin', 'test', 'WidgetSpec.groovy'), 'class WidgetSpec {}\n');
			writeFile(path.join(root, 'bin', 'default', 'Widget.groovy'), 'class Widget {}\n');
			writeFile(path.join(root, 'bin', 'Deploy.groovy'), 'class Deploy {}\n');
			writeFile(path.join(root, 'scripts', 'main', 'Task.groovy'), 'class Task {}\n');

			const files = (await collectSourceFilesFromDirectory(root)).map(file => path.relative(root, file).split(path.sep).join('/'));

			assert.deepStrictEqual(files, ['bin/Deploy.groovy', 'scripts/main/Task.groovy', 'services/Widget.groovy']);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('finds monorepo root when workspace folder is a submodule', () => {
		const root = createFixtureMonorepo();
		try {
			const webRoot = path.join(root, 'web');
			const monorepoRoot = findGrailsMonorepoRoot([{ uri: { fsPath: webRoot } }]);
			assert.strictEqual(monorepoRoot, root);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
