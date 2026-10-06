import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { GrailsArtifactIndex, indexGroovyFile } from '../../groovy/grails_artifact_index';
import {
	parseMemberAccess,
	resolveMethodCompletions,
	resolveReceiverClassNames
} from '../../groovy/method_completion_logic';
import { listMethodsInText } from '../../groovy/method_navigation_logic';

const fixturesRoot = path.resolve(__dirname, '../../../src/test/fixtures/groovy');

function loadFixture(name: string): string {
	return fs.readFileSync(path.join(fixturesRoot, name), 'utf8');
}

function buildArtifactIndex(): GrailsArtifactIndex {
	const index = new GrailsArtifactIndex();
	for (const file of ['ModelEntity.groovy', 'Widget.groovy', 'WidgetService.groovy', 'WidgetController.groovy']) {
		index.addEntry(indexGroovyFile(path.join(fixturesRoot, file)));
	}
	return index;
}

suite('method_completion_logic', () => {
	test('parses receiver and optional method prefix after dot', () => {
		assert.deepStrictEqual(parseMemberAccess('widgetService.'), { receiver: 'widgetService', prefix: '' });
		assert.deepStrictEqual(parseMemberAccess('\treturn widgetService.sa'), {
			receiver: 'widgetService',
			prefix: 'sa'
		});
		assert.strictEqual(parseMemberAccess('Widget widget = new Widget()'), undefined);
	});

	test('reads the declared type of a field, a local variable and a parameter in scope', () => {
		const source = loadFixture('WidgetController.groovy');
		assert.strictEqual(resolveReceiverClassNames(source, 'widgetService', 10)[0], 'WidgetService');
		assert.strictEqual(resolveReceiverClassNames(source, 'widget', 10)[0], 'Widget');
		assert.strictEqual(resolveReceiverClassNames(source, 'widget', 14)[0], 'Widget');
	});

	test('does not type a receiver from a declaration in another method', () => {
		const source = 'class Caller {\n    def a() {\n        Order item = build()\n    }\n    def b() {\n        item.\n    }\n}';
		assert.deepStrictEqual(resolveReceiverClassNames(source, 'item', 5), ['Item']);
	});

	test('lists methods from Groovy source text', () => {
		const names = listMethodsInText(loadFixture('WidgetService.groovy')).map(method => method.name);
		assert.ok(names.includes('save'));
	});

	test('suggests service methods after widgetService.', () => {
		const completions = resolveMethodCompletions({
			linePrefix: '\t\treturn widgetService.',
			documentText: loadFixture('WidgetController.groovy'),
			artifactIndex: buildArtifactIndex()
		});
		assert.ok(completions.some(item => item.name === 'save'));
		assert.ok(completions.every(item => item.name !== 'WidgetService'));
	});

	test('filters by typed prefix after the dot', () => {
		const completions = resolveMethodCompletions({
			linePrefix: '\t\treturn widgetService.sa',
			documentText: loadFixture('WidgetController.groovy'),
			artifactIndex: buildArtifactIndex()
		});
		assert.deepStrictEqual(
			completions.map(item => item.name),
			['save']
		);
	});

	test('includes inherited methods for Widget receiver', () => {
		const completions = resolveMethodCompletions({
			linePrefix: '\t\twidget.',
			documentText: loadFixture('WidgetController.groovy'),
			artifactIndex: buildArtifactIndex()
		});
		const names = completions.map(item => item.name);
		assert.ok(names.includes('rename'));
		assert.ok(names.includes('touch'));
	});
});
