import * as assert from 'assert';
import {
	applyLocalRename,
	collectLocalRenameEdits,
	prepareLocalRename,
	wordRangeAt
} from '../../groovy/rename_logic';

suite('rename_logic', () => {
	test('prepareLocalRename finds the identifier under the cursor', () => {
		const text = 'def widgetService\nwidgetService.save()';
		const offset = text.indexOf('widgetService.save') + 3;
		const prepared = prepareLocalRename(text, offset);
		assert.ok(prepared);
		assert.strictEqual(prepared!.placeholder, 'widgetService');
		assert.strictEqual(text.slice(prepared!.range.start, prepared!.range.end), 'widgetService');
	});

	test('rejects keywords', () => {
		const text = 'return value';
		assert.strictEqual(prepareLocalRename(text, text.indexOf('return') + 1), undefined);
	});

	test('renames all code occurrences in the file', () => {
		const text = [
			'class WidgetService {',
			'  WidgetService self',
			'  def save(WidgetService service) {',
			'    service',
			'  }',
			'}'
		].join('\n');
		const edits = collectLocalRenameEdits(text, 'WidgetService', 'PaymentService');
		assert.strictEqual(edits.length, 3);
		const renamed = applyLocalRename(text, 'WidgetService', 'PaymentService');
		assert.ok(renamed.includes('class PaymentService'));
		assert.ok(renamed.includes('PaymentService self'));
		assert.ok(renamed.includes('save(PaymentService service)'));
		assert.ok(!renamed.includes('WidgetService'));
	});

	test('skips occurrences inside comments and strings', () => {
		const text = [
			'def foo = 1',
			'// foo should stay',
			'/* foo stay */',
			'def bar = "foo"',
			"def baz = 'foo'",
			'foo = 2'
		].join('\n');
		const edits = collectLocalRenameEdits(text, 'foo', 'qux');
		assert.strictEqual(edits.length, 2);
		const renamed = applyLocalRename(text, 'foo', 'qux');
		assert.ok(renamed.includes('// foo should stay'));
		assert.ok(renamed.includes('/* foo stay */'));
		assert.ok(renamed.includes('"foo"'));
		assert.ok(renamed.includes("'foo'"));
		assert.ok(renamed.includes('def qux = 1'));
		assert.ok(renamed.includes('qux = 2'));
	});

	test('skips triple-quoted strings', () => {
		const text = 'def foo = 1\ndef msg = """foo"""\nfoo++';
		const renamed = applyLocalRename(text, 'foo', 'bar');
		assert.ok(renamed.includes('"""foo"""'));
		assert.ok(renamed.includes('def bar = 1'));
		assert.ok(renamed.includes('bar++'));
	});

	test('wordRangeAt handles cursor at end of identifier', () => {
		const text = 'widget';
		const range = wordRangeAt(text, text.length);
		assert.ok(range);
		assert.strictEqual(text.slice(range!.start, range!.end), 'widget');
	});
});

suite('collectLocalRenameEdits — strings the shared scanner understands', () => {
	test('renames inside GString interpolation but not inside slashy or dollar-slashy strings', () => {
		const text = 'def total = 1\ndef a = "${total}"\ndef b = ~/total/\ndef c = $/total/$\nprintln total';
		assert.strictEqual(applyLocalRename(text, 'total', 'sum'), 'def sum = 1\ndef a = "${sum}"\ndef b = ~/total/\ndef c = $/total/$\nprintln sum');
	});
});
