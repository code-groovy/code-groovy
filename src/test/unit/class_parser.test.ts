import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { importedTypeName, listExistingImports, parseImports, parsePackageName, parseTypesFromSource, resolveTypeName } from '../../groovy/class_parser';

const fixture = fs.readFileSync(
	path.resolve(__dirname, '../../../src/test/fixtures/groovy/SampleService.groovy'),
	'utf8'
);

suite('class_parser', () => {
	test('extracts package and top-level class, interface, trait, and enum', () => {
		const types = parseTypesFromSource(fixture, 'SampleService.groovy');
		assert.deepStrictEqual(
			types.map(t => ({ kind: t.kind, simpleName: t.simpleName, fqn: t.fqn })),
			[
				{ kind: 'class', simpleName: 'SampleService', fqn: 'com.demo.services.SampleService' },
				{ kind: 'interface', simpleName: 'SamplePort', fqn: 'com.demo.services.SamplePort' },
				{ kind: 'trait', simpleName: 'SampleTrait', fqn: 'com.demo.services.SampleTrait' },
				{ kind: 'enum', simpleName: 'SampleStatus', fqn: 'com.demo.services.SampleStatus' }
			]
		);
	});

	test('parses default-package types', () => {
		const types = parseTypesFromSource('class Orphan {}\n');
		assert.strictEqual(types[0].packageName, '');
		assert.strictEqual(types[0].fqn, 'Orphan');
	});

	test('reads package name and existing imports including star imports', () => {
		const text = `
package com.demo

import grails.validation.Validateable
import com.demo.util.*
`;
		assert.strictEqual(parsePackageName(text), 'com.demo');
		const imports = listExistingImports(text);
		assert.ok(imports.has('grails.validation.Validateable'));
		assert.ok(imports.has('com.demo.util'));
	});
});

suite('parseImports', () => {
	test('keeps aliases, skips static imports and marks wildcards', () => {
		assert.deepStrictEqual(parseImports('import a.b.C\nimport static a.b.C.d\nimport x.y.*\nimport m.N as Alias'), ['a.b.C', 'x.y.*', 'm.N as Alias']);
	});

	test('finds an imported type by the name the file uses, including an alias', () => {
		const imports = parseImports('import a.b.C\nimport m.N as Alias\nimport x.y.*');
		assert.strictEqual(importedTypeName(imports, 'C'), 'a.b.C');
		assert.strictEqual(importedTypeName(imports, 'Alias'), 'm.N');
		assert.strictEqual(importedTypeName(imports, 'N'), undefined);
	});
});

suite('resolveTypeName', () => {
	const imports = ['a.Explicit', 'lib.one.Base as OneBase', 'w.*'];

	test('prefers an explicit or aliased import, then the same package, then a wildcard import, then a unique known type', () => {
		assert.strictEqual(resolveTypeName('Explicit', 'p', imports, ['a.Explicit', 'p.Explicit']), 'a.Explicit');
		assert.strictEqual(resolveTypeName('OneBase', 'p', imports, []), 'lib.one.Base');
		assert.strictEqual(resolveTypeName('Local', 'p', imports, ['p.Local', 'w.Local']), 'p.Local');
		assert.strictEqual(resolveTypeName('Wild', 'p', imports, ['w.Wild', 'z.Wild']), 'w.Wild');
		assert.strictEqual(resolveTypeName('Only', 'p', imports, ['z.Only']), 'z.Only');
		assert.strictEqual(resolveTypeName('Many', 'p', imports, ['y.Many', 'z.Many']), undefined);
	});

	test('falls back to the same package when nothing is known about the name', () => {
		assert.strictEqual(resolveTypeName('Thing', 'p', imports), 'p.Thing');
		assert.strictEqual(resolveTypeName('com.x.Thing', 'p', imports), 'com.x.Thing');
	});
});
