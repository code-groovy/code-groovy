import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	hashWorkspaceBuildFiles,
	parseClasspathLines,
	prioritizeJars,
	resolveProjectClasspath,
	resolveGradleProjectRoot
} from '../../groovy/classpath_resolver';

suite('classpath_resolver', () => {
	let workspace: string;
	setup(() => { workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'code-groovy-cp-test-')); });
	teardown(() => { fs.rmSync(workspace, { recursive: true, force: true }); });

	function write(relative: string, content = ''): string {
		const file = path.join(workspace, relative);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
		return file;
	}

	test('resolves the configured Kotlin DSL Gradle project', async () => {
		const wrapper = write('app/gradlew');
		write('app/settings.gradle.kts');
		write('app/build.gradle.kts');
		const main = write('cache/main.jar');
		const spock = write('cache/spock-core.jar');
		const result = await resolveProjectClasspath(workspace, async (command, args, options) => {
			assert.strictEqual(command, wrapper);
			assert.strictEqual(options.cwd, path.join(workspace, 'app'));
			assert.strictEqual(args[args.length - 1], 'printCodeGroovyClasspath');
			assert.ok(fs.readFileSync(args[2], 'utf8').includes('testCompileClasspath'));
			return [main, spock, main].map(jar => `CODE_GROOVY_CP:${jar}`).join('\n');
		}, 'app');
		assert.strictEqual(result.tool, 'gradle');
		assert.deepStrictEqual(new Set(result.jars), new Set([main, spock]));
	});

	test('does not automatically search child projects without a setting', async () => {
		write('app/gradlew');
		const result = await resolveProjectClasspath(workspace, async () => {
			assert.fail('No Gradle command should run');
		});
		assert.strictEqual(result.tool, 'none');
	});

	test('configured nested project takes precedence over the workspace wrapper', async () => {
		write('gradlew');
		const wrapper = write('services/backend/gradlew');
		const jar = write('cache/main.jar');
		const result = await resolveProjectClasspath(workspace, async (command, _args, options) => {
			assert.strictEqual(command, wrapper);
			assert.strictEqual(options.cwd, path.join(workspace, 'services/backend'));
			return `CODE_GROOVY_CP:${jar}`;
		}, 'services/backend');
		assert.strictEqual(result.tool, 'gradle');
	});

	test('runs in the configured project directory when using an ancestor wrapper', async () => {
		const wrapper = write('gradlew');
		write('app/build.gradle.kts');
		const jar = write('cache/main.jar');
		await resolveProjectClasspath(workspace, async (command, _args, options) => {
			assert.strictEqual(command, wrapper);
			assert.strictEqual(options.cwd, path.join(workspace, 'app'));
			return `CODE_GROOVY_CP:${jar}`;
		}, 'app');
	});

	test('accepts absolute project paths', async () => {
		const wrapper = write('app/gradlew');
		const jar = write('cache/main.jar');
		await resolveProjectClasspath(workspace, async (command, _args, options) => {
			assert.strictEqual(command, wrapper);
			assert.strictEqual(options.cwd, path.join(workspace, 'app'));
			return `CODE_GROOVY_CP:${jar}`;
		}, path.join(workspace, 'app'));
	});

	test('reports invalid configured directories without falling back to another build', async () => {
		write('gradlew');
		write('not-a-directory');
		for (const projectDir of ['missing', 'not-a-directory']) {
			const result = await resolveProjectClasspath(workspace, async () => {
				assert.fail('An invalid configured directory must not run another build');
			}, projectDir);
			assert.strictEqual(result.tool, 'none');
			assert.ok(result.warning?.includes('Configured Gradle project directory'));
		}
	});

	test('reports a configured project without a wrapper', async () => {
		write('app/build.gradle.kts');
		const result = await resolveProjectClasspath(workspace, async () => {
			assert.fail('No wrapper is available');
		}, 'app');
		assert.strictEqual(result.tool, 'none');
		assert.ok(result.warning?.includes('Gradle Wrapper'));
	});

	test('cache hashes distinguish configured project directories', () => {
		write('one/build.gradle.kts', 'plugins {}');
		write('two/build.gradle.kts', 'plugins {}');
		assert.notStrictEqual(
			hashWorkspaceBuildFiles(resolveGradleProjectRoot(workspace, 'one')),
			hashWorkspaceBuildFiles(resolveGradleProjectRoot(workspace, 'two'))
		);
	});

	test('prefers a root wrapper over child wrappers', async () => {
		const wrapper = write('gradlew');
		write('app/gradlew');
		const jar = write('cache/main.jar');
		let calls = 0;
		await resolveProjectClasspath(workspace, async (command, _args, options) => {
			calls++;
			assert.strictEqual(command, wrapper);
			assert.strictEqual(options.cwd, workspace);
			return `CODE_GROOVY_CP:${jar}`;
		});
		assert.strictEqual(calls, 1);
	});

	test('retains ancestor wrapper resolution for module workspaces', async () => {
		const wrapper = write('gradlew');
		write('module/build.gradle');
		const jar = write('cache/main.jar');
		const result = await resolveProjectClasspath(path.join(workspace, 'module'), async (command, _args, options) => {
			assert.strictEqual(command, wrapper);
			assert.strictEqual(options.cwd, workspace);
			return `CODE_GROOVY_CP:${jar}`;
		});
		assert.strictEqual(result.tool, 'gradle');
	});

	test('invalidates the cache when nested Kotlin settings change', () => {
		write('app/settings.gradle.kts', 'rootProject.name = "app"');
		const before = hashWorkspaceBuildFiles(workspace);
		write('app/settings.gradle.kts', 'include("library")');
		assert.notStrictEqual(hashWorkspaceBuildFiles(workspace), before);
	});

	test('parses Gradle CODE_GROOVY_CP lines', () => {
		const output = [
			'Some gradle noise',
			'CODE_GROOVY_CP:/cache/grails-validation-5.0.0.jar',
			'CODE_GROOVY_CP:/cache/groovy-3.0.0.jar',
			'CODE_GROOVY_CP:/cache/groovy-3.0.0.jar'
		].join('\n');
		assert.deepStrictEqual(parseClasspathLines(output), [
			'/cache/grails-validation-5.0.0.jar',
			'/cache/groovy-3.0.0.jar'
		]);
	});

	test('parses Maven dependency:build-classpath output', () => {
		const jars = [
			'/repo/grails-core-5.0.0.jar',
			'/repo/spring-core-5.3.0.jar'
		];
		const line = jars.join(path.delimiter);
		assert.deepStrictEqual(parseClasspathLines(line), jars);
	});

	test('prioritizes grails and groovy jars', () => {
		const ranked = prioritizeJars([
			'/lib/commons-lang.jar',
			'/lib/spring-core.jar',
			'/lib/grails-validation.jar',
			'/lib/groovy-all.jar'
		], 3);
		assert.deepStrictEqual(ranked, [
			'/lib/grails-validation.jar',
			'/lib/groovy-all.jar',
			'/lib/spring-core.jar'
		]);
	});

	test('hashes build files so cache keys change with the project', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-groovy-hash-'));
		try {
			fs.writeFileSync(path.join(dir, 'build.gradle'), 'dependencies {}\n');
			const first = hashWorkspaceBuildFiles(dir);
			fs.writeFileSync(path.join(dir, 'build.gradle'), 'dependencies { implementation "org.grails:grails-core" }\n');
			const second = hashWorkspaceBuildFiles(dir);
			assert.notStrictEqual(first, second);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
