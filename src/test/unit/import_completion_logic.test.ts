import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { ClassIndexStore, indexJarFqns, indexSourceText } from '../../groovy/class_index_store';
import { applyImportInsertion } from '../../groovy/import_edits';
import { extractTypePrefix, resolveTypeCompletions } from '../../groovy/import_completion_logic';
import { resolveImportCodeActions } from '../../groovy/import_code_action_logic';

const issueSource = fs.readFileSync(
	path.resolve(__dirname, '../../../src/test/fixtures/groovy/validateable-doc.groovy'),
	'utf8'
);
const sampleSource = fs.readFileSync(
	path.resolve(__dirname, '../../../src/test/fixtures/groovy/SampleService.groovy'),
	'utf8'
);

function issueStore(): ClassIndexStore {
	const store = new ClassIndexStore();
	store.add(indexJarFqns(['grails.validation.Validateable'], 'grails-validation.jar'));
	store.add(indexSourceText(sampleSource, 'SampleService.groovy'));
	return store;
}

suite('import completion and code action (issue #3)', () => {
	test('detects type prefixes after implements and capitalized identifiers', () => {
		assert.deepStrictEqual(extractTypePrefix('class Person implements Val'), {
			prefix: 'Val',
			replaceLength: 3
		});
		assert.deepStrictEqual(extractTypePrefix('    Validateable'), {
			prefix: 'Validateable',
			replaceLength: 12
		});
		assert.strictEqual(extractTypePrefix('import grails.validation.Val'), undefined);
		assert.strictEqual(extractTypePrefix('person.name'), undefined);
	});

	test('suggests Validateable and inserts grails.validation.Validateable', () => {
		const store = issueStore();
		const linePrefix = 'class Person implements Val';
		const completions = resolveTypeCompletions(linePrefix, issueSource, store);
		const match = completions.find(item => item.fqn === 'grails.validation.Validateable');
		assert.ok(match);
		assert.strictEqual(match.simpleName, 'Validateable');
		assert.strictEqual(match.importInsertion.needed, true);
		assert.strictEqual(match.importInsertion.text, 'import grails.validation.Validateable\n');

		const updated = applyImportInsertion(issueSource, match.importInsertion);
		assert.ok(updated.includes('import grails.validation.Validateable\n'));
		assert.ok(updated.includes('class Person implements Validateable'));
	});

	test('lists every FQN when the simple name is ambiguous', () => {
		const store = issueStore();
		store.add(indexJarFqns(['com.other.Validateable']));
		const completions = resolveTypeCompletions('implements Validateable', issueSource, store);
		assert.deepStrictEqual(
			completions.map(item => item.fqn).sort(),
			['com.other.Validateable', 'grails.validation.Validateable']
		);
	});

	test('Quick Fix adds the import for the word under the cursor', () => {
		const store = issueStore();
		const line = 'class Person implements Validateable {';
		const actions = resolveImportCodeActions(issueSource, line, line.indexOf('Validateable') + 3, store);
		assert.strictEqual(actions.length, 1);
		assert.strictEqual(actions[0].title, "Add import for 'grails.validation.Validateable'");
		assert.strictEqual(actions[0].insertion.text, 'import grails.validation.Validateable\n');
	});

	test('keeps workspace Pet ahead of later JAR Pet* types', () => {
		const store = new ClassIndexStore();
		const jarTypes = Array.from({ length: 60 }, (_, i) => `com.plugin.PetExtra${i}`);
		jarTypes.push('com.plugin.PetProfileDTO');
		store.add(indexJarFqns(jarTypes));
		store.add(indexSourceText('package com.demo\nclass Pet {}\n', 'Pet.groovy'));
		store.add(indexSourceText('package com.demo\nclass PetProfile {}\n', 'PetProfile.groovy'));

		const completions = resolveTypeCompletions('Pet', issueSource, store);
		assert.ok(completions.some(item => item.fqn === 'com.demo.Pet'));
		assert.ok(completions.some(item => item.fqn === 'com.demo.PetProfile'));
		assert.strictEqual(completions[0].fqn, 'com.demo.Pet');
		assert.strictEqual(completions[1].fqn, 'com.demo.PetProfile');
	});

	test('does not offer an import that already exists', () => {
		const store = issueStore();
		const source = 'package com.demo\nimport grails.validation.Validateable\n\nclass Person implements Validateable {}\n';
		const completions = resolveTypeCompletions('class Person implements Validateable', source, store);
		assert.strictEqual(completions[0].importInsertion.needed, false);
		assert.deepStrictEqual(
			resolveImportCodeActions(source, 'class Person implements Validateable {}', 28, store),
			[]
		);
	});
});
