import * as assert from 'assert';
import { applyImportInsertion, planImportInsertion } from '../../groovy/import_edits';

suite('import_edits', () => {
	test('inserts import after the package declaration', () => {
		const source = 'package com.demo\n\nclass Person implements Validateable {\n}\n';
		const plan = planImportInsertion(source, 'grails.validation.Validateable');
		assert.strictEqual(plan.needed, true);
		assert.strictEqual(plan.text, 'import grails.validation.Validateable\n');

		const updated = applyImportInsertion(source, plan);
		assert.ok(updated.startsWith('package com.demo\nimport grails.validation.Validateable\n'));
	});

	test('does not duplicate an existing import', () => {
		const source = 'package com.demo\nimport grails.validation.Validateable\n\nclass Person {}\n';
		const plan = planImportInsertion(source, 'grails.validation.Validateable');
		assert.strictEqual(plan.needed, false);
		assert.strictEqual(applyImportInsertion(source, plan), source);
	});

	test('skips same-package types', () => {
		const source = 'package grails.validation\n\nclass Person implements Validateable {}\n';
		assert.strictEqual(planImportInsertion(source, 'grails.validation.Validateable').needed, false);
	});

	test('treats star imports as already covering the package', () => {
		const source = 'package com.demo\nimport grails.validation.*\n\nclass Person {}\n';
		assert.strictEqual(planImportInsertion(source, 'grails.validation.Validateable').needed, false);
	});

	test('inserts the new import in sorted position without reordering others', () => {
		const source = [
			'package com.demo',
			'import com.example.app.security.AccessRule',
			'import com.example.app.util.TextKit',
			'import grails.plugin.springsecurity.SpringSecurityUtils',
			'import java.util.concurrent.TimeUnit',
			'import grails.validation.Validateable',
			'',
			'class Person {}',
			''
		].join('\n');

		const updated = applyImportInsertion(
			source,
			planImportInsertion(source, 'com.example.app.domain.Widget')
		);

		assert.ok(
			updated.includes(
				'import com.example.app.domain.Widget\nimport com.example.app.security.AccessRule\n'
			)
		);
		// Existing out-of-order Validateable stays where it was.
		assert.ok(
			updated.includes(
				'import java.util.concurrent.TimeUnit\nimport grails.validation.Validateable\n'
			)
		);
	});

	test('inserts converter imports after core util in ASCII order', () => {
		const source = [
			'package com.example.service',
			'import com.example.lib.AlphaHelper',
			'import com.example.lib.CoreUtils',
			'import com.example.store.repository.OrderRepository',
			'',
			'class Example {}',
			''
		].join('\n');

		const updated = applyImportInsertion(
			source,
			planImportInsertion(source, 'com.example.lib.converter.StringConverter')
		);

		assert.ok(
			updated.includes(
				'import com.example.lib.CoreUtils\nimport com.example.lib.converter.StringConverter\nimport com.example.store.repository.OrderRepository\n'
			)
		);
	});

	test('inserts before a later package group when that is the sorted spot', () => {
		const source = 'package com.demo\nimport java.time.LocalDate\n\nclass Person {}\n';
		const updated = applyImportInsertion(
			source,
			planImportInsertion(source, 'grails.validation.Validateable')
		);
		assert.ok(
			updated.includes(
				'import grails.validation.Validateable\nimport java.time.LocalDate\n'
			)
		);
	});
});
