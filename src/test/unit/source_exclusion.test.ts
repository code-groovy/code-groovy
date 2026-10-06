import * as assert from 'assert';
import { isExcludedDirectory, isExcludedRelativePath, SOURCE_EXCLUDE_GLOB } from '../../groovy/source_exclusion';

suite('source_exclusion', () => {
	test('excludes build tool and dependency folders', () => {
		for (const name of ['node_modules', '.git', 'build', 'target', 'out']) {
			assert.strictEqual(isExcludedDirectory(name, 'project'), true, name);
		}
	});

	test('excludes Java language server output folders only under bin', () => {
		assert.strictEqual(isExcludedDirectory('main', 'bin'), true);
		assert.strictEqual(isExcludedDirectory('test', 'bin'), true);
		assert.strictEqual(isExcludedDirectory('default', 'bin'), true);
		assert.strictEqual(isExcludedDirectory('main', 'src'), false);
		assert.strictEqual(isExcludedDirectory('bin', 'project'), false);
		assert.strictEqual(isExcludedDirectory('scripts', 'bin'), false);
	});

	test('checks every directory of a workspace relative path', () => {
		assert.strictEqual(isExcludedRelativePath('projects/coredomain/bin/main/coredomain/customer/CustomerService.groovy'), true);
		assert.strictEqual(isExcludedRelativePath('app/bin/default/bin/default/Widget.groovy'), true);
		assert.strictEqual(isExcludedRelativePath('web\\bin\\default\\Widget.groovy'), true);
		assert.strictEqual(isExcludedRelativePath('web/node_modules/pkg/Widget.groovy'), true);
		assert.strictEqual(isExcludedRelativePath('projects/coredomain/grails-app/services/coredomain/customer/CustomerService.groovy'), false);
		assert.strictEqual(isExcludedRelativePath('src/main/groovy/com/example/Widget.groovy'), false);
		assert.strictEqual(isExcludedRelativePath('bin/Deploy.groovy'), false);
		assert.strictEqual(isExcludedRelativePath('main/Widget.groovy'), false);
	});

	test('builds one glob with every excluded folder', () => {
		assert.strictEqual(SOURCE_EXCLUDE_GLOB, '**/{node_modules,.git,build,target,out,bin/main,bin/test,bin/default}/**');
	});
});
