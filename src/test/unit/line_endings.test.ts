import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { analyzeSource } from '../../groovy/call_site_extractor';
import { CallSiteIndexStore } from '../../groovy/call_site_index_store';
import { indexSourceText } from '../../groovy/source_indexer';
import { parseDocumentSymbols } from '../../groovy/symbol_parser';
import { TypeHierarchyStore } from '../../groovy/type_hierarchy_store';
import { resolveUsages } from '../../groovy/usage_lookup_logic';

const fixturesRoot = path.resolve(__dirname, '../../../src/test/fixtures/groovy');

const MULTI_CLASS = [
	'package a',
	'enum Color {',
	'    RED("r"),',
	'    GREEN("g")',
	'    Color(String code) {}',
	'}',
	'class Base {',
	'    void save() {}',
	'}',
	'class Child extends Base implements Serializable {',
	'    /* block',
	'       comment */',
	'    void run() {',
	'        super.save()',
	'        def pattern = ~/x\\/y/',
	'        Color.RED.name()',
	'    }',
	'}'
].join('\n');

function sources(): Record<string, string> {
	const files: Record<string, string> = { '/w/a/Multi.groovy': MULTI_CLASS };
	for (const name of fs.readdirSync(fixturesRoot).filter(file => file.endsWith('.groovy'))) {
		files[path.join(fixturesRoot, name)] = fs.readFileSync(path.join(fixturesRoot, name), 'utf8');
	}
	return files;
}

function toCrlf(text: string): string {
	return text.replace(/\r?\n/g, '\r\n');
}

function buildStores(files: Record<string, string>): { index: CallSiteIndexStore; hierarchy: TypeHierarchyStore } {
	const index = new CallSiteIndexStore();
	const hierarchy = new TypeHierarchyStore();
	const callSites = [];
	for (const [sourcePath, text] of Object.entries(files)) {
		const indexed = indexSourceText(text, sourcePath);
		hierarchy.add(indexed.types, indexed.methods, indexed.imports, indexed.fields, indexed.enumConstants);
		index.addTypeMentions(sourcePath, indexed.typeMentions);
		callSites.push(...indexed.callSites);
	}
	index.add(callSites);
	return { index, hierarchy };
}

suite('line endings', () => {
	const lf = sources();
	const crlf = Object.fromEntries(Object.entries(lf).map(([sourcePath, text]) => [sourcePath, toCrlf(text)]));

	test('parses the same symbols from LF and CRLF sources', () => {
		for (const sourcePath of Object.keys(lf)) {
			assert.deepStrictEqual(parseDocumentSymbols(crlf[sourcePath], sourcePath), parseDocumentSymbols(lf[sourcePath], sourcePath), sourcePath);
		}
	});

	test('extracts the same call sites from LF and CRLF sources', () => {
		for (const sourcePath of Object.keys(lf)) {
			assert.deepStrictEqual(analyzeSource(crlf[sourcePath], sourcePath), analyzeSource(lf[sourcePath], sourcePath), sourcePath);
		}
	});

	test('finds the same usages through the hierarchy', () => {
		const fromLf = buildStores(lf);
		const fromCrlf = buildStores(crlf);
		const target = { kind: 'method' as const, name: 'save', className: 'Base', classFqn: 'a.Base' };
		const describe = (stores: ReturnType<typeof buildStores>) =>
			resolveUsages(target, stores.index, 'references', stores.hierarchy).records.map(record => `${record.sourcePath}:${record.line}:${record.column}`);
		assert.deepStrictEqual(describe(fromCrlf), describe(fromLf));
		assert.strictEqual(describe(fromLf).length > 0, true);
		assert.deepStrictEqual(fromCrlf.hierarchy.parentsOf('a.Child'), fromLf.hierarchy.parentsOf('a.Child'));
	});
});
