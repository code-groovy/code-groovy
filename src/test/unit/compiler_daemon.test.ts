import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { javaCommandFromEnv } from '../../groovy/compile_diagnostic_logic';
import { CompilerDaemonClient } from '../../groovy/compiler_daemon';

const GROOVY_JAR_URL = 'https://repo1.maven.org/maven2/org/codehaus/groovy/groovy/2.5.14/groovy-2.5.14.jar';

const PERSON = [
	'package sample',
	'',
	'import groovy.transform.CompileStatic',
	'',
	'@CompileStatic',
	'class Person {',
	'',
	'    String name',
	'    Integer age',
	'',
	'    String greet(String greeting) {',
	'        return "${greeting}, ${name}"',
	'    }',
	'}',
	''
].join('\n');

interface CompileCase {
	id: string;
	source: string;
	message: string;
	needle: string;
	last?: boolean;
}

const CASES: CompileCase[] = [
	caseOf('S1', 'Cannot find matching method', 'Optional.ofNullable', `
        Boolean operatorWithIncompatibleType() {
            return 1 + Optional.ofNullable(null)
        }`, true),
	caseOf('S2', 'Cannot assign value of type', 'Integer total', `
        void incompatibleAssignment() {
            Integer total = "abc"
        }`, true),
	caseOf('S3', 'Cannot return value of type', 'return "text"', `
        Integer incompatibleReturn() {
            return "text"
        }`, true),
	caseOf('S4', 'String#shout()', 'text.shout()', `
        void unknownMethod() {
            String text = "hello"
            text.shout()
        }`, true),
	caseOf('S5', 'nickname', 'person.nickname', `
        void unknownProperty() {
            Person person = new Person(name: "Ana", age: 30)
            println person.nickname
        }`, true),
	caseOf('S6', 'Person#greet(int)', 'person.greet(42)', `
        void wrongArgumentType() {
            Person person = new Person(name: "Ana", age: 30)
            person.greet(42)
        }`, true),
	caseOf('S7', 'Person#greet(java.lang.String, java.lang.String)', 'person.greet("Hi", "extra")', `
        void wrongArgumentCount() {
            Person person = new Person(name: "Ana", age: 30)
            person.greet("Hi", "extra")
        }`, true),
	caseOf('S8', 'Incompatible generic argument types', 'List<String> names', `
        void incompatibleGenerics() {
            List<String> names = [1, 2, 3]
        }`, true),
	caseOf('S9', 'String#shout()', 'name.shout()', `
        void unknownMethodInsideClosure() {
            List<String> names = ["Ana", "Bia"]
            names.each { String name -> name.shout() }
        }`, true),
	caseOf('S10', 'height', 'height: 1.70', `
        void unknownNamedArgument() {
            new Person(name: "Ana", height: 1.70)
        }`, true),
	caseOf('S11', 'static context', 'incompatibleReturn()', `
        static void instanceMethodFromStatic() {
            incompatibleReturn()
        }
        Integer incompatibleReturn() {
            return 1
        }`, true),
	caseOf('E1', 'InvoiceCalculator', 'new InvoiceCalculator()', `
        void unknownClass() {
            new InvoiceCalculator()
        }`, false),
	caseOf('E2', 'LocalDate', 'LocalDate.now()', `
        void missingImport() {
            LocalDate today = LocalDate.now()
        }`, false),
	caseOf('E3', 'label', 'String label = "b"', `
        void duplicateVariable() {
            String label = "a"
            String label = "b"
        }`, false),
	caseOf('E4', 'return statement with an expression', 'return 10', `
        void returnValueFromVoid() {
            return 10
        }`, false),
	caseOf('E5', 'final field', 'code = "B2"', `
        final String code = "A1"
        void assignFinalField() {
            code = "B2"
        }`, false),
	caseOf('E6', 'static scope', 'println code', `
        String code = "A1"
        static void instanceFieldFromStatic() {
            println code
        }`, false),
	{
		id: 'E7',
		message: 'duplicates another method',
		needle: 'void run() {}',
		last: true,
		source: [
			'package sample',
			'class DuplicatedMethod {',
			'    void run() {}',
			'    void run() {}',
			'}',
			''
		].join('\n')
	},
	{
		id: 'E8',
		message: 'abstract method',
		needle: 'class Square implements Shape',
		source: [
			'package sample',
			'interface Shape {',
			'    BigDecimal area()',
			'}',
			'class Square implements Shape {',
			'}',
			''
		].join('\n')
	},
	{
		id: 'E9',
		message: 'final method',
		needle: '"sales"',
		source: [
			'package sample',
			'class BaseReport {',
			'    final String title() { "base" }',
			'}',
			'class SalesReport extends BaseReport {',
			'    String title() { "sales" }',
			'}',
			''
		].join('\n')
	},
	caseOf('X1', 'unexpected token', '        }', `
        void unclosedParenthesis() {
            println("hello"
        }`, false),
	caseOf('X2', '', 'String text', `
        void unterminatedString() {
            String text = "hello
        }`, false),
	caseOf('X3', '', 'Integer total', `
        void danglingOperator() {
            Integer total = 1 +
        }`, false)
];

suite('compiler_daemon', () => {
	test('reports the groovy 2.5.14 errors from issue 57', async function () {
		this.timeout(180_000);
		const groovyJar = await ensureGroovyJar();
		const work = fs.mkdtempSync(path.join(os.tmpdir(), 'code-groovy-diag-'));
		const classes = path.join(work, 'classes');
		fs.mkdirSync(classes);
		compileGroovy(groovyJar, PERSON, path.join(work, 'Person.groovy'), classes);

		const daemonDir = path.join(__dirname, '..', '..', 'compiler');
		const logs: string[] = [];
		const client = new CompilerDaemonClient(daemonDir, message => logs.push(message), work);
		const classFilesBefore = classFiles(work);
		try {
			const clean = await client.compile('Ok.groovy', 'package sample\nclass Ok {\n    int value() { return 1 }\n}\n', [classes, groovyJar]);
			assert.deepStrictEqual(clean, [], `clean file produced ${JSON.stringify(clean)} logs=${logs.join('\n')}`);

			const failures: string[] = [];
			for (const item of CASES) {
				const diagnostics = await client.compile(`${item.id}.groovy`, item.source, [classes, groovyJar]);
				if (diagnostics.length === 0) {
					failures.push(`${item.id} produced no diagnostics`);
					continue;
				}
				if (!item.message) {
					continue;
				}
				const match = diagnostics.find(diagnostic => diagnostic.message.toLowerCase().includes(item.message.toLowerCase()));
				if (!match) {
					failures.push(`${item.id} expected "${item.message}" in ${diagnostics.map(diagnostic => diagnostic.message).join(' | ')}`);
					continue;
				}
				const line = lineOf(item.source, item.needle, item.last);
				if (match.line !== line) {
					failures.push(`${item.id} pointed at line ${match.line}, expected ${line} (${item.needle}) message=${match.message}`);
				}
			}
			assert.deepStrictEqual(failures, []);

			const both = [
				'package sample',
				'import groovy.transform.CompileStatic',
				'@CompileStatic',
				'class Both {',
				'    void incompatibleAssignment() { Integer total = "abc" }',
				'    void unknownMethod() { String text = "hello"; text.shout() }',
				'}',
				''
			].join('\n');
			const combined = await client.compile('Both.groovy', both, [classes, groovyJar]);
			assert.ok(combined.some(diagnostic => diagnostic.message.includes('Cannot assign value of type')));
			assert.ok(combined.some(diagnostic => diagnostic.message.includes('String#shout()')));

			const syntax = [
				'package sample',
				'class SyntaxErrors {',
				'    void unclosedParenthesis() {',
				'        println("hello"',
				'    }',
				'    void unterminatedString() {',
				'        String text = "hello',
				'    }',
				'}',
				''
			].join('\n');
			const firstSyntax = await client.compile('SyntaxErrors.groovy', syntax, [classes, groovyJar]);
			assert.strictEqual(firstSyntax.length, 1, JSON.stringify(firstSyntax));
			assert.ok(firstSyntax[0].message.toLowerCase().includes('unexpected token'));

			const stale = await client.compile('Person.groovy', PERSON.replace('Integer age', 'Integer age\n    void broken() { Integer total = "abc" }'), [classes, groovyJar]);
			assert.ok(
				stale.some(diagnostic => diagnostic.message.includes('Cannot assign value of type')),
				`stale Person.class hid the error: ${JSON.stringify(stale)}`
			);
			assert.deepStrictEqual(classFiles(work).sort(), classFilesBefore.sort());
		} finally {
			client.dispose();
			fs.rmSync(work, { recursive: true, force: true });
		}
	});
});

function caseOf(id: string, message: string, needle: string, body: string, compileStatic: boolean): CompileCase {
	const header = ['package sample'];
	if (compileStatic) {
		header.push('', 'import groovy.transform.CompileStatic', '', '@CompileStatic');
	}
	header.push(`class Case${id} {`, body.replace(/^\n/, ''), '}', '');
	return { id, message, needle, source: header.join('\n') };
}

function lineOf(source: string, needle: string, last = false): number {
	const lines = source.split('\n');
	let found = -1;
	for (let index = 0; index < lines.length; index++) {
		if (lines[index].includes(needle)) {
			found = index + 1;
			if (!last) {
				return found;
			}
		}
	}
	if (found < 0) {
		throw new Error(`Needle not in source: ${needle}`);
	}
	return found;
}

async function ensureGroovyJar(): Promise<string> {
	const dest = path.join(os.tmpdir(), 'code-groovy-groovy-2.5.14.jar');
	if (fs.existsSync(dest) && fs.statSync(dest).size > 1_000_000) {
		return dest;
	}
	const response = await fetch(GROOVY_JAR_URL);
	if (!response.ok) {
		throw new Error(`Could not download Groovy ${response.status}`);
	}
	fs.writeFileSync(dest, Buffer.from(await response.arrayBuffer()));
	return dest;
}

function compileGroovy(groovyJar: string, source: string, filePath: string, outDir: string): void {
	fs.writeFileSync(filePath, source);
	const java = javaCommandFromEnv(process.env, candidate => fs.existsSync(candidate));
	const result = spawnSync(java, ['-cp', groovyJar, 'org.codehaus.groovy.tools.FileSystemCompiler', '-d', outDir, filePath], {
		encoding: 'utf8'
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout || `groovyc exited ${result.status}`);
	}
}

function classFiles(dir: string): string[] {
	if (!fs.existsSync(dir)) {
		return [];
	}
	const found: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			found.push(...classFiles(full));
		} else if (entry.name.endsWith('.class')) {
			found.push(full);
		}
	}
	return found;
}
