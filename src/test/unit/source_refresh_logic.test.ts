import * as assert from 'assert';
import { planSourceRefresh } from '../../groovy/source_refresh_logic';

suite('planSourceRefresh', () => {
	test('indexes new files and keeps cached files that did not change', () => {
		const plan = planSourceRefresh(['/a.groovy', '/b.groovy'], ['/a.groovy'], new Set(), false);
		assert.deepStrictEqual([...plan.toIndex], ['/b.groovy']);
		assert.deepStrictEqual(plan.removed, []);
	});

	test('reindexes cached files that changed', () => {
		const plan = planSourceRefresh(['/a.groovy', '/b.groovy'], ['/a.groovy', '/b.groovy'], new Set(['/b.groovy']), false);
		assert.deepStrictEqual([...plan.toIndex], ['/b.groovy']);
	});

	test('drops cached files that are no longer listed, even when they changed', () => {
		const plan = planSourceRefresh(['/a.groovy'], ['/a.groovy', '/gone.groovy'], new Set(['/gone.groovy']), false);
		assert.deepStrictEqual(plan.removed, ['/gone.groovy']);
		assert.deepStrictEqual([...plan.toIndex], []);
	});

	test('a full refresh drops the whole cache and reindexes every listed file', () => {
		const plan = planSourceRefresh(['/a.groovy', '/b.groovy'], ['/a.groovy', '/gone.groovy'], new Set(), true);
		assert.deepStrictEqual(plan.removed, ['/a.groovy', '/gone.groovy']);
		assert.deepStrictEqual([...plan.toIndex], ['/a.groovy', '/b.groovy']);
	});
});
