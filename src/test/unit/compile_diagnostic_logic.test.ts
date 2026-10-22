import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	buildCompileClasspath,
	classpathHasGroovy,
	compilerDiagnosticSpan,
	findCompileOutputDirs,
	inlineErrorLabels,
	inlineErrorText,
	isGroovyRuntimeJar,
	javaCommandFromEnv,
	orderCompileClasspath,
	parseDaemonMessage
} from '../../groovy/compile_diagnostic_logic';

suite('compile_diagnostic_logic', () => {
	test('recognises the groovy runtime jar and ignores module and sources jars', () => {
		assert.strictEqual(isGroovyRuntimeJar('/repo/groovy-2.5.14.jar'), true);
		assert.strictEqual(isGroovyRuntimeJar('/repo/groovy-all-2.5.14.jar'), true);
		assert.strictEqual(isGroovyRuntimeJar('/repo/groovy-4.0.21.jar'), true);
		assert.strictEqual(isGroovyRuntimeJar('/repo/groovy.jar'), true);
		assert.strictEqual(isGroovyRuntimeJar('/repo/groovy-dateutil-2.5.14.jar'), false);
		assert.strictEqual(isGroovyRuntimeJar('/repo/groovy-json-3.0.9.jar'), false);
		assert.strictEqual(isGroovyRuntimeJar('/repo/groovy-2.5.14-sources.jar'), false);
		assert.strictEqual(classpathHasGroovy(['/repo/groovy-json-3.0.9.jar']), false);
		assert.strictEqual(classpathHasGroovy(['/repo/groovy-2.5.14.jar']), true);
	});

	test('puts project output dirs before groovy and the rest of the classpath', () => {
		assert.deepStrictEqual(orderCompileClasspath(
			['/app/build/classes/groovy/main'],
			['/repo/spring.jar', '/repo/groovy-2.5.14.jar', '/repo/groovy-json-3.0.9.jar']
		), [
			'/app/build/classes/groovy/main',
			'/repo/groovy-2.5.14.jar',
			'/repo/spring.jar',
			'/repo/groovy-json-3.0.9.jar'
		]);
	});

	test('finds module build output directories', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-groovy-out-'));
		const output = path.join(root, 'web', 'build', 'classes', 'groovy', 'main');
		fs.mkdirSync(output, { recursive: true });
		fs.mkdirSync(path.join(root, 'build'), { recursive: true });
		try {
			assert.deepStrictEqual(findCompileOutputDirs(root), [output]);
			assert.deepStrictEqual(buildCompileClasspath(root, ['/missing/groovy-2.5.14.jar']), [output]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('parses a compiler response and ignores other stdout', () => {
		assert.strictEqual(parseDaemonMessage('Picked up JAVA_TOOL_OPTIONS'), undefined);
		const message = parseDaemonMessage(
			'CODE_GROOVY_DIAG:{"id":"4","diagnostics":[{"message":"Cannot assign value of type String to variable of type Integer","severity":"error","line":8,"column":9,"endLine":8,"endColumn":20}]}'
		);
		assert.strictEqual(message?.id, '4');
		assert.strictEqual(message?.diagnostics?.length, 1);
		assert.strictEqual(message?.diagnostics?.[0].line, 8);
		assert.strictEqual(message?.diagnostics?.[0].column, 9);
	});

	test('underlines the whole line the compiler reported, not just the token', () => {
		const lines = ['package sample', '        Integer total = "abc"'];
		const span = compilerDiagnosticSpan({
			message: 'Cannot assign value of type String to variable of type Integer',
			severity: 'error',
			line: 2,
			column: 9,
			endLine: 2,
			endColumn: 22
		}, lines.length, line => lines[line].length);
		assert.deepStrictEqual(span, {
			startLine: 1,
			startCharacter: 0,
			endLine: 1,
			endCharacter: lines[1].length
		});
	});

	test('joins messages on the same line for the inline overlay', () => {
		const labels = inlineErrorLabels([
			{ message: 'Cannot assign value of type String', severity: 'error', line: 4, column: 9, endLine: 4, endColumn: 20 },
			{ message: 'Cannot assign value of type String', severity: 'error', line: 4, column: 9, endLine: 4, endColumn: 20 },
			{ message: '  second\nproblem  ', severity: 'warning', line: 4, column: 1, endLine: 4, endColumn: 2 }
		]);
		assert.deepStrictEqual(labels, [{
			line: 4,
			text: 'Cannot assign value of type String · second problem',
			warning: false
		}]);
		assert.ok(inlineErrorText('x'.repeat(250)).endsWith('…'));
		assert.strictEqual(inlineErrorText('x'.repeat(250)).length, 200);
	});

	test('underlines the whole line when the compiler has no column', () => {
		const span = compilerDiagnosticSpan({
			message: 'startup failed',
			severity: 'error',
			line: 1,
			column: 0,
			endLine: 0,
			endColumn: 0
		}, 1, () => 12);
		assert.deepStrictEqual(span, {
			startLine: 0,
			startCharacter: 0,
			endLine: 0,
			endCharacter: 12
		});
	});

	test('uses JAVA_HOME when that java exists', () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), 'code-groovy-java-'));
		const executable = process.platform === 'win32' ? 'java.exe' : 'java';
		const bin = path.join(home, 'bin', executable);
		fs.mkdirSync(path.dirname(bin), { recursive: true });
		fs.writeFileSync(bin, '');
		try {
			assert.strictEqual(javaCommandFromEnv({ JAVA_HOME: home }, candidate => candidate === bin), bin);
			assert.strictEqual(javaCommandFromEnv({}, () => false), 'java');
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
		}
	});
});
