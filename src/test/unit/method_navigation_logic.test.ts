import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
	classParents,
	findFieldInClassHierarchy,
	findMethodInClassHierarchy,
	findMethodInText,
	listMethodsInClassHierarchy,
	listMethodsInText,
	preferReferencedEntries
} from '../../groovy/method_navigation_logic';
import { parseDocumentSymbols } from '../../groovy/symbol_parser';

const fixturesRoot = path.resolve(__dirname, '../../../src/test/fixtures/groovy');

function loadFixture(name: string): string {
	return fs.readFileSync(path.join(fixturesRoot, name), 'utf8');
}

suite('listMethodsInText', () => {
	test('lists def, typed and modifier-only declarations of the requested class', () => {
		const source = [
			'class Utils {',
			'\tpublic static withNewTransaction(Closure mainCode) {',
			'\t}',
			'',
			'\tprivate static buildList(List<Map> itemList) {',
			'\t}',
			'\t@SuppressWarnings("unchecked") static helper() {}',
			'\tfinal foo() {}',
			'\tsynchronized bar() {}',
			'}'
		].join('\n');
		assert.deepStrictEqual(findMethodInText(source, 'withNewTransaction').map(location => location.line), [1]);
		assert.deepStrictEqual(findMethodInText(source, 'buildList').map(location => location.line), [4]);
		assert.deepStrictEqual(listMethodsInText(source, 'Utils').map(method => method.name), ['withNewTransaction', 'buildList', 'helper', 'foo', 'bar']);
	});

	test('leaves out constructors, declarations inside strings and methods of other classes', () => {
		const source = [
			'enum Color {',
			'    RED("r")',
			'    private Color(String code) {}',
			'    String label() { "x" }',
			'    static class Inner {',
			'        public Inner() {}',
			'        void innerOnly() {}',
			'    }',
			'    String sql = """',
			'        void ghost() {}',
			'    """',
			'}'
		].join('\n');
		assert.deepStrictEqual(listMethodsInText(source, 'Color').map(method => method.name), ['label']);
		assert.deepStrictEqual(listMethodsInText(source, 'Inner').map(method => method.name), ['innerOnly']);
	});

	test('reads the parents of the requested class, dropping generics and packages', () => {
		const source = 'class OrderRepository implements Repository<Order, OrderRepository>, com.acme.Auditable {\n}';
		assert.deepStrictEqual(classParents(parseDocumentSymbols(source, '/tmp/OrderRepository.groovy'), 'OrderRepository'), ['Repository', 'Auditable']);
	});

	test('finds def and typed method declarations in a fixture', () => {
		const source = loadFixture('WidgetService.groovy');
		assert.ok(findMethodInText(source, 'save').length > 0);
	});
});

suite('findMethodInClassHierarchy — same-named supertypes', () => {
	const sources: Record<string, string> = {
		'/w/debit/BaseRequestBuilder.groovy': 'package adyen.debit\nclass BaseRequestBuilder {\n    Map buildAmount() {\n    }\n}',
		'/w/credit/BaseRequestBuilder.groovy': 'package adyen.credit\nclass BaseRequestBuilder {\n    Map buildAmount() {\n    }\n}',
		'/w/debit/AuthoriseRequestBuilder.groovy': 'package adyen.debit\nclass AuthoriseRequestBuilder extends BaseRequestBuilder {\n}',
		'/w/other/PixRequestBuilder.groovy': 'package other\nimport adyen.debit.BaseRequestBuilder\nclass PixRequestBuilder extends BaseRequestBuilder {\n}'
	};
	const readFile = (filePath: string) => sources[filePath];
	const findEntries = (className: string) => Object.keys(sources)
		.filter(filePath => filePath.endsWith(`/${className}.groovy`))
		.sort((a, b) => a.includes('credit') ? -1 : b.includes('credit') ? 1 : 0)
		.map(filePath => ({ filePath }));
	const lookup = (className: string, referencing?: string) =>
		findMethodInClassHierarchy(readFile, findEntries, className, 'buildAmount', new Set(), 0, referencing).map(location => location.filePath);

	test('picks the supertype in the same package as the subclass', () => {
		assert.deepStrictEqual(lookup('AuthoriseRequestBuilder'), ['/w/debit/BaseRequestBuilder.groovy']);
	});

	test('picks the supertype named by an explicit import', () => {
		assert.deepStrictEqual(lookup('PixRequestBuilder'), ['/w/debit/BaseRequestBuilder.groovy']);
	});

	test('picks the class the referencing file refers to when the name itself is ambiguous', () => {
		assert.deepStrictEqual(lookup('BaseRequestBuilder', 'package adyen.debit\nclass X {\n}'), ['/w/debit/BaseRequestBuilder.groovy']);
	});
});

suite('listMethodsInClassHierarchy — same-named classes and supertypes', () => {
	const sources: Record<string, string> = {
		'/w/credit/BaseRequestBuilder.groovy': 'package adyen.credit\nclass BaseRequestBuilder {\n    Map buildAmount() {\n    }\n    Map buildInstallments() {\n    }\n}',
		'/w/debit/BaseRequestBuilder.groovy': 'package adyen.debit\nclass BaseRequestBuilder {\n    Map buildAmount() {\n    }\n    String buildReference() {\n    }\n}',
		'/w/credit/AuthoriseRequestBuilder.groovy': 'package adyen.credit\nclass AuthoriseRequestBuilder extends BaseRequestBuilder {\n    Map build() {\n    }\n}',
		'/w/debit/AuthoriseRequestBuilder.groovy': 'package adyen.debit\nclass AuthoriseRequestBuilder extends BaseRequestBuilder {\n    Map build() {\n    }\n}'
	};
	const readFile = (filePath: string) => sources[filePath];
	const findEntries = (className: string) => Object.keys(sources)
		.filter(filePath => filePath.endsWith(`/${className}.groovy`))
		.sort()
		.map(filePath => ({ filePath }));
	const names = (referencing?: string) =>
		listMethodsInClassHierarchy(readFile, findEntries, 'AuthoriseRequestBuilder', new Set(), 0, referencing).map(method => method.name);

	test('lists the inherited methods of the class the document refers to', () => {
		assert.deepStrictEqual(names('package adyen\nimport adyen.debit.AuthoriseRequestBuilder\nclass X {\n}'), ['build', 'buildAmount', 'buildReference']);
	});

	test('resolves each same-named class against its own supertype when the document does not pick one', () => {
		assert.deepStrictEqual(names(), ['build', 'buildAmount', 'buildInstallments', 'buildReference']);
	});
});

suite('preferReferencedEntries', () => {
	const files: Record<string, string> = {
		'/a/Widget.groovy': 'package a\nclass Widget {}',
		'/b/Widget.groovy': 'package b\nclass Widget {}'
	};
	const entries = [{ filePath: '/a/Widget.groovy' }, { filePath: '/b/Widget.groovy' }];
	const prefer = (content: string) => preferReferencedEntries(entries, 'Widget', filePath => files[filePath], content).map(entry => entry.filePath);

	test('follows an explicit import, but not one that renames the class to an alias', () => {
		assert.deepStrictEqual(prefer('package c\nimport b.Widget\nclass C {}'), ['/b/Widget.groovy']);
		assert.deepStrictEqual(prefer('package c\nimport b.Widget as W\nimport a.*\nclass C {}'), ['/a/Widget.groovy']);
	});

	test('falls back to the same package and then to wildcard imports', () => {
		assert.deepStrictEqual(prefer('package a;\nclass C {}'), ['/a/Widget.groovy']);
		assert.deepStrictEqual(prefer('package c\nimport b.*\nclass C {}'), ['/b/Widget.groovy']);
		assert.deepStrictEqual(prefer('package c\nclass C {}'), ['/a/Widget.groovy', '/b/Widget.groovy']);
	});
});

suite('findFieldInClassHierarchy', () => {
	const files: Record<string, string> = {
		'/p/Base.groovy': 'package p\nclass Base {\n    String code\n}',
		'/q/Base.groovy': 'package q\nclass Base {\n    String other\n    String code\n}',
		'/q/Child.groovy': 'package q\nclass Child extends Base implements Named, Coded {\n}',
		'/q/Named.groovy': 'package q\ninterface Named extends Root {\n}',
		'/q/Coded.groovy': 'package q\ninterface Coded extends Root {\n}',
		'/q/Root.groovy': 'package q\ninterface Root {\n}'
	};
	const entriesFor = (className: string) => Object.keys(files)
		.filter(filePath => filePath.endsWith(`/${className}.groovy`))
		.map(filePath => ({ filePath }));

	test('picks the homonym parent from the same package as the class that extends it', () => {
		const found = findFieldInClassHierarchy(filePath => files[filePath], entriesFor, 'Child', 'code', 'package q\nclass Caller {}');
		assert.deepStrictEqual(found, [{ filePath: '/q/Base.groovy', line: 3, column: 11, typeName: 'String' }]);
	});

	test('reads a type reached through two paths only once', () => {
		const reads: string[] = [];
		const found = findFieldInClassHierarchy(filePath => {
			reads.push(filePath);
			return files[filePath];
		}, entriesFor, 'Child', 'missing', 'package q');
		assert.deepStrictEqual(found, []);
		assert.strictEqual(reads.filter(filePath => filePath === '/q/Root.groovy').length, 1);
	});
});
