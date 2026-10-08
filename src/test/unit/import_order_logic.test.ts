import * as assert from 'assert';
import { findOutOfOrderImports } from '../../groovy/import_order_logic';

suite('import_order_logic', () => {
	test('flags imports that are lexicographically before the previous line', () => {
		const source = [
			'package com.demo',
			'import com.example.app.util.TextKit',
			'import java.util.concurrent.TimeUnit',
			'import grails.validation.Validateable',
			'',
			'class Person {}'
		].join('\n');

		const issues = findOutOfOrderImports(source);
		assert.strictEqual(issues.length, 1);
		assert.strictEqual(issues[0].line, 3);
		assert.strictEqual(issues[0].text, 'import grails.validation.Validateable');
		assert.strictEqual(issues[0].previousText, 'import java.util.concurrent.TimeUnit');
	});

	test('returns no issues when imports are already sorted', () => {
		const source = [
			'package com.demo',
			'import com.example.app.util.TextKit',
			'import grails.validation.Validateable',
			'import java.util.concurrent.TimeUnit',
			'',
			'class Person {}'
		].join('\n');

		assert.deepStrictEqual(findOutOfOrderImports(source), []);
	});

	test('does not flag ASCII order where core util comes before converter subpackage', () => {
		const source = [
			'package com.example.service',
			'import com.example.lib.AlphaHelper',
			'import com.example.lib.CoreUtils',
			'import com.example.lib.converter.IntConverter',
			'import com.example.lib.converter.StringConverter',
			'import com.example.store.repository.OrderRepository',
			'',
			'class Example {}'
		].join('\n');

		assert.deepStrictEqual(findOutOfOrderImports(source), []);
	});
});
