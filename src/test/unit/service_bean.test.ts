import * as assert from 'assert';
import { candidateClassNamesForReceiver, grailsFieldNameForClass, serviceBeanToClassName } from '../../groovy/service_bean';

suite('service_bean', () => {
	test('maps widgetService to WidgetService', () => {
		assert.strictEqual(serviceBeanToClassName('widgetService'), 'WidgetService');
		assert.deepStrictEqual(candidateClassNamesForReceiver('widget'), ['Widget']);
	});
});

suite('grailsFieldNameForClass', () => {
	test('lowercases the first letter', () => {
		assert.strictEqual(grailsFieldNameForClass('WidgetService'), 'widgetService');
	});

	test('keeps names starting with an acronym as-is, like Spring bean naming', () => {
		assert.strictEqual(grailsFieldNameForClass('URLService'), 'URLService');
	});

	test('handles a single-letter name', () => {
		assert.strictEqual(grailsFieldNameForClass('A'), 'a');
	});
});
