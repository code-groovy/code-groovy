import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	buildGradleDebugCommand,
	buildInitialDebugConfigurations,
	collectDebugSourcePaths,
	defaultLaunchName,
	defaultRequest,
	detectDebugProject,
	dynamicDebugConfigurations,
	extractAppReadyUrl,
	resolveAppServerUrl,
	findGradleWrapper,
	bootRunDebugJvmFlags,
	gradleJavaExecJdwpInitScript,
	gradleStartupTimeoutMs,
	remapGradleBuildOutputToSource,
	hasGradleAppTaskStarted,
	isBootRunLikeGradleTask,
	isJdwpListening,
	parseDebugPort,
	pickJavaProjectName,
	readGradleDebugStatus,
	toJavaAttachConfig
} from '../../debug/groovy_debug_logic';

function writeFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

function createGrailsMonorepo(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-groovy-debug-'));
	writeFile(path.join(root, 'settings.gradle'), 'include "domain", "web"\n');
	writeFile(path.join(root, 'gradlew'), '#!/bin/sh\n');
	writeFile(
		path.join(root, 'domain', 'grails-app', 'domain', 'com', 'example', 'Widget.groovy'),
		'class Widget {}\n'
	);
	writeFile(
		path.join(root, 'web', 'grails-app', 'controllers', 'com', 'example', 'WidgetController.groovy'),
		'class WidgetController {}\n'
	);
	writeFile(path.join(root, 'web', 'src', 'main', 'groovy', 'placeholder.txt'), '');
	return root;
}

suite('groovy_debug_logic', () => {
	test('parses debug port from number or string', () => {
		assert.strictEqual(parseDebugPort(8000), 8000);
		assert.strictEqual(parseDebugPort('5006'), 5006);
		assert.strictEqual(parseDebugPort('nope'), 5005);
		assert.strictEqual(parseDebugPort(undefined), 5005);
	});

	test('detects Grails monorepo, web bootRun and source paths', () => {
		const root = createGrailsMonorepo();
		try {
			const project = detectDebugProject(root);
			assert.strictEqual(project.kind, 'grails');
			assert.strictEqual(project.projectRoot, root);
			assert.ok(project.gradlew?.endsWith('gradlew'));
			assert.strictEqual(project.launchTask, 'bootRun');
			assert.strictEqual(project.launchModule, 'web');
			assert.ok(project.sourcePaths.some(item => item.includes(path.join('web', 'grails-app'))));
			assert.ok(project.sourcePaths.some(item => item.includes(path.join('domain', 'grails-app'))));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('builds qualified Gradle debug command for the web module', () => {
		const root = createGrailsMonorepo();
		try {
			const project = detectDebugProject(root);
			const initDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-init-'));
			const command = buildGradleDebugCommand(project, {}, initDir);
			assert.ok(command);
			assert.strictEqual(command!.cwd, root);
			assert.strictEqual(command!.args[0], ':web:bootRun');
			assert.strictEqual(command!.args[1], '--console=rich');
			assert.strictEqual(command!.args[2], '-I');
			assert.ok(command!.args[3].endsWith('.gradle'));
			assert.ok(fs.readFileSync(command!.args[3], 'utf8').includes('jdwp'));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('honours gradleConsole plain', () => {
		const root = createGrailsMonorepo();
		try {
			const project = detectDebugProject(root);
			const initDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-init-'));
			const command = buildGradleDebugCommand(project, { gradleConsole: 'plain' }, initDir);
			assert.strictEqual(command?.args[1], '--console=plain');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('honours explicit module, task and extra Gradle args', () => {
		const root = createGrailsMonorepo();
		try {
			const project = detectDebugProject(root);
			const initDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-init-'));
			const command = buildGradleDebugCommand(project, {
				module: 'api',
				task: 'bootRun',
				gradleArgs: ['-Dgrails.env=test']
			}, initDir);
			assert.strictEqual(command?.args[0], ':api:bootRun');
			assert.strictEqual(command?.args[1], '--console=rich');
			assert.strictEqual(command?.args[2], '-I');
			assert.deepStrictEqual(command?.args.slice(4), ['-Dgrails.env=test']);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('detects Micronaut and uses the run task', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-groovy-mn-'));
		try {
			writeFile(path.join(root, 'gradlew'), '#!/bin/sh\n');
			writeFile(path.join(root, 'build.gradle'), 'plugins { id "io.micronaut.application" }\n');
			writeFile(path.join(root, 'src', 'main', 'groovy', 'app', 'Application.groovy'), 'class Application {}\n');
			const project = detectDebugProject(root);
			assert.strictEqual(project.kind, 'micronaut');
			assert.strictEqual(project.launchTask, 'run');
			assert.strictEqual(defaultLaunchName(project.kind), 'Groovy: Launch Micronaut');
			const initDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-init-'));
			const command = buildGradleDebugCommand(project, {}, initDir);
			assert.strictEqual(command?.args[0], 'run');
			assert.strictEqual(command?.args[1], '--console=rich');
			assert.strictEqual(command?.args[2], '-I');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('maps groovy config to a Java attach configuration', () => {
		const config = toJavaAttachConfig(
			{ name: 'Groovy: Attach', hostName: '127.0.0.1', port: '5006', projectName: 'web' },
			['/tmp/src/main/groovy', '/tmp/src/main/groovy']
		);
		assert.strictEqual(config.type, 'java');
		assert.strictEqual(config.request, 'attach');
		assert.strictEqual(config.hostName, '127.0.0.1');
		assert.strictEqual(config.port, 5006);
		assert.strictEqual(config.projectName, 'web');
		assert.deepStrictEqual(config.sourcePaths, [path.normalize('/tmp/src/main/groovy')]);
	});

	test('defaults launch vs attach from project kind', () => {
		assert.strictEqual(defaultRequest('grails', true), 'launch');
		assert.strictEqual(defaultRequest('unknown', true), 'attach');
		assert.strictEqual(defaultRequest('grails', false), 'attach');
	});

	test('recognises JDWP listening output', () => {
		assert.ok(isJdwpListening('Listening for transport dt_socket at address: 5005\n'));
		assert.ok(isJdwpListening('Listening for transport dt_socket at address: localhost:5005\n'));
		assert.ok(!isJdwpListening('Starting Gradle Daemon...\n'));
	});

	test('detects bootRun/run task start in Gradle output', () => {
		assert.ok(hasGradleAppTaskStarted('> Task :web:bootRun\n'));
		assert.ok(hasGradleAppTaskStarted('> Task :app:bootRun\n'));
		assert.ok(!hasGradleAppTaskStarted('> Task :web:compileGroovy\n'));
	});

	test('remaps Gradle bin/default copies back to grails-app sources', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-grails-src-'));
		try {
			const source = path.join(root, 'web', 'grails-app', 'controllers', 'com', 'example', 'AppController.groovy');
			fs.mkdirSync(path.dirname(source), { recursive: true });
			fs.writeFileSync(source, 'class AppController {}\n');
			const buildCopy = path.join(root, 'web', 'bin', 'default', 'grails-app', 'controllers', 'com', 'example', 'AppController.groovy');
			fs.mkdirSync(path.dirname(buildCopy), { recursive: true });
			fs.writeFileSync(buildCopy, 'class AppController {}\n');
			assert.strictEqual(
				remapGradleBuildOutputToSource(buildCopy),
				source
			);
			assert.strictEqual(
				remapGradleBuildOutputToSource(source),
				source
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('uses configured attach timeout with a safe default', () => {
		assert.strictEqual(gradleStartupTimeoutMs(180_000), 180_000);
		assert.strictEqual(gradleStartupTimeoutMs(900_000), 900_000);
		assert.strictEqual(gradleStartupTimeoutMs(Number.NaN), 600_000);
	});

	test('adds --debug-jvm only when explicitly enabled', () => {
		assert.ok(isBootRunLikeGradleTask(':web:bootRun'));
		assert.deepStrictEqual(bootRunDebugJvmFlags(':web:bootRun', [], false), []);
		assert.deepStrictEqual(bootRunDebugJvmFlags(':web:bootRun', [], true), ['--debug-jvm']);
		assert.deepStrictEqual(bootRunDebugJvmFlags(':web:compileGroovy', [], true), []);
	});

	test('writes a Gradle init script that enables JDWP on JavaExec', () => {
		const script = gradleJavaExecJdwpInitScript(5005);
		assert.ok(script.includes('taskGraph.whenReady'));
		assert.ok(script.includes('target.doFirst'));
		assert.ok(script.includes('codeGroovyTargetTaskPath'));
		assert.ok(script.includes('address=127.0.0.1:5005'));
		assert.ok(script.includes('suspend=n'));
		assert.ok(gradleJavaExecJdwpInitScript(5005, ':web:bootRun', 'y').includes('suspend=y'));
	});

	test('java attach config disables stopOnEntry', () => {
		const config = toJavaAttachConfig({ port: 5005 }, []);
		assert.strictEqual(config.stopOnEntry, false);
	});

	test('extracts Grails app URL from bootRun output', () => {
		const log = 'Grails application running at http://localhost:8080/myapp in environment: development';
		assert.strictEqual(extractAppReadyUrl(log), 'http://localhost:8080/myapp');
		assert.strictEqual(resolveAppServerUrl(log, 'http://localhost:9999'), 'http://localhost:9999');
	});

	test('reads Gradle debug phases from bootRun output', () => {
		assert.strictEqual(readGradleDebugStatus('Starting Gradle Daemon...\n').phase, 'starting');
		assert.strictEqual(
			readGradleDebugStatus('> Task :web:compileGroovy\n> Task :web:compileJava\n').phase,
			'compiling'
		);
		assert.strictEqual(
			readGradleDebugStatus('> Task :web:compileGroovy\n> Task :web:bootRun\n').phase,
			'compiled'
		);
		assert.strictEqual(
			readGradleDebugStatus([
				'> Task :web:bootRun',
				'Listening for transport dt_socket at address: 5005'
			].join('\n')).phase,
			'jdwp'
		);
		assert.strictEqual(
			readGradleDebugStatus([
				'> Task :web:bootRun',
				'Listening for transport dt_socket at address: 5005',
				'Grails application running at http://localhost:8080'
			].join('\n')).phase,
			'running'
		);
		assert.strictEqual(readGradleDebugStatus('FAILURE: Build failed with an exception.\n').phase, 'failed');
	});

	test('finds the Gradle wrapper walking up from a submodule', () => {
		const root = createGrailsMonorepo();
		try {
			const wrapper = findGradleWrapper(path.join(root, 'web', 'grails-app'));
			assert.strictEqual(wrapper, path.join(root, 'gradlew'));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('from a web submodule still maps domain sources and :web:bootRun', () => {
		const root = createGrailsMonorepo();
		try {
			const project = detectDebugProject(path.join(root, 'web'));
			assert.strictEqual(project.kind, 'grails');
			assert.strictEqual(project.projectRoot, root);
			assert.strictEqual(project.launchModule, 'web');
			assert.ok(project.sourcePaths.some(item => item.includes(path.join('domain', 'grails-app'))));
			const initDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-init-'));
			const command = buildGradleDebugCommand(project, {}, initDir);
			assert.strictEqual(command?.args[0], ':web:bootRun');
			assert.strictEqual(command?.args[2], '-I');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('collects root source paths for a single-module app', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-groovy-single-'));
		try {
			writeFile(path.join(root, 'grails-app', 'controllers', 'HomeController.groovy'), 'class HomeController {}\n');
			const paths = collectDebugSourcePaths(root);
			assert.ok(paths.some(item => item.endsWith('grails-app')));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('builds launch.json starter configs', () => {
		const configs = buildInitialDebugConfigurations();
		assert.strictEqual(configs.length, 2);
		assert.ok(configs.every(config => config.type === 'groovy'));
	});

	test('does not offer dynamic configs when launch.json already has groovy', () => {
		const generated = buildInitialDebugConfigurations();
		assert.strictEqual(dynamicDebugConfigurations(generated, undefined).length, 2);
		assert.deepStrictEqual(dynamicDebugConfigurations(generated, []), generated);
		assert.deepStrictEqual(
			dynamicDebugConfigurations(generated, [{ type: 'java' }]),
			generated
		);
		assert.deepStrictEqual(
			dynamicDebugConfigurations(generated, [{ type: 'groovy' }]),
			[]
		);
	});

	test('picks Java projectName from config, JDT names or Gradle module', () => {
		assert.strictEqual(pickJavaProjectName({ configured: 'web' }), 'web');
		assert.strictEqual(pickJavaProjectName({
			launchModule: 'web',
			jdtNames: ['myapp-core', 'web']
		}), 'web');
		assert.strictEqual(pickJavaProjectName({
			launchModule: 'web',
			jdtNames: ['myapp-core.web']
		}), 'myapp-core.web');
		assert.strictEqual(pickJavaProjectName({
			projectRoot: '/repo/myapp-core',
			jdtNames: ['myapp-core']
		}), 'myapp-core');
	});
});
