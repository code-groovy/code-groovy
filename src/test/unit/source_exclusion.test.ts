import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	createNestedWorktreeFilter,
	isExcludedDirectory,
	isExcludedRelativePath,
	isLinkedWorktreeGitFile,
	limitSourceFiles,
	SOURCE_EXCLUDE_GLOB
} from '../../groovy/source_exclusion';

function writeFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

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

	test('ignores paths outside the workspace, which stay absolute', () => {
		assert.strictEqual(isExcludedRelativePath('/home/dev/build/project/bin/main/Widget.groovy'), false);
		assert.strictEqual(isExcludedRelativePath('C:\\work\\out\\project\\Widget.groovy'), false);
	});

	test('recognizes the .git file of a linked worktree, not of a submodule', () => {
		assert.strictEqual(isLinkedWorktreeGitFile('gitdir: /work/app/.git/worktrees/feature-x\n'), true);
		assert.strictEqual(isLinkedWorktreeGitFile('gitdir: C:\\work\\app\\.git\\worktrees\\feature-x\r\n'), true);
		assert.strictEqual(isLinkedWorktreeGitFile('gitdir: ../../.git/worktrees/feature-x\n'), true);
		assert.strictEqual(isLinkedWorktreeGitFile('gitdir: /work/app/.git/modules/shared/worktrees/feature-x\n'), true);
		assert.strictEqual(isLinkedWorktreeGitFile('gitdir: /work/app.git/worktrees/feature-x\n'), true);
		assert.strictEqual(isLinkedWorktreeGitFile('gitdir: ../.git/modules/shared\n'), false);
		assert.strictEqual(isLinkedWorktreeGitFile('gitdir: /home/dev/worktrees/project\n'), false);
		assert.strictEqual(isLinkedWorktreeGitFile('gitdir: /work/app/.git/modules/worktrees/feature-x\n'), false);
		assert.strictEqual(isLinkedWorktreeGitFile('[core]\n\trepositoryformatversion = 0\n'), false);
	});

	test('filters files inside linked worktrees nested in the workspace', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-groovy-worktrees-'));
		try {
			const worktree = path.join(root, '.claude', 'worktrees', 'feature-x');
			writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
			writeFile(path.join(root, 'projects', 'core', 'Widget.groovy'), 'class Widget {}\n');
			writeFile(path.join(worktree, '.git'), `gitdir: ${path.join(root, '.git', 'worktrees', 'feature-x')}\n`);
			writeFile(path.join(worktree, 'projects', 'core', 'Widget.groovy'), 'class Widget {}\n');
			writeFile(path.join(root, 'libs', 'shared', '.git'), 'gitdir: ../../.git/modules/shared\n');
			writeFile(path.join(root, 'libs', 'shared', 'Helper.groovy'), 'class Helper {}\n');

			const insideWorktree = createNestedWorktreeFilter([root]);
			assert.strictEqual(insideWorktree(path.join(root, 'projects', 'core', 'Widget.groovy')), false);
			assert.strictEqual(insideWorktree(path.join(worktree, 'projects', 'core', 'Widget.groovy')), true);
			assert.strictEqual(insideWorktree(path.join(root, 'libs', 'shared', 'Helper.groovy')), false);

			const openedWorktree = createNestedWorktreeFilter([worktree]);
			assert.strictEqual(openedWorktree(path.join(worktree, 'projects', 'core', 'Widget.groovy')), false);

			const otherFolder = createNestedWorktreeFilter([path.join(root, 'projects')]);
			assert.strictEqual(otherFolder(path.join(worktree, 'projects', 'core', 'Widget.groovy')), false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('applies the file limit after leaving out excluded files', () => {
		const files = ['wt/A.groovy', 'wt/B.groovy', 'src/C.groovy', 'src/D.groovy', 'src/E.groovy'];
		const insideWorktree = (filePath: string) => filePath.startsWith('wt/');
		assert.deepStrictEqual(limitSourceFiles(files, insideWorktree, 2), ['src/C.groovy', 'src/D.groovy']);
		assert.deepStrictEqual(limitSourceFiles(files, insideWorktree, 0), ['src/C.groovy', 'src/D.groovy', 'src/E.groovy']);
	});

	test('builds one glob with every excluded folder', () => {
		assert.strictEqual(SOURCE_EXCLUDE_GLOB, '**/{node_modules,.git,build,target,out,bin/main,bin/test,bin/default}/**');
	});
});
