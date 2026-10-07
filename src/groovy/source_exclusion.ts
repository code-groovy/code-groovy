import * as fs from 'fs';
import * as path from 'path';

const EXCLUDED_DIRECTORY_NAMES = new Set(['node_modules', '.git', 'build', 'target', 'out']);
const JAVA_OUTPUT_PARENT = 'bin';
const JAVA_OUTPUT_DIRECTORY_NAMES = new Set(['main', 'test', 'default']);
const LINKED_WORKTREE_GITDIR_RE = /^gitdir:.*[\\/]worktrees[\\/][^\\/\r\n]+\s*$/m;

export const SOURCE_EXCLUDE_GLOB = `**/{${[
	...EXCLUDED_DIRECTORY_NAMES,
	...[...JAVA_OUTPUT_DIRECTORY_NAMES].map(name => `${JAVA_OUTPUT_PARENT}/${name}`)
].join(',')}}/**`;

export function isExcludedDirectory(name: string, parentName: string): boolean {
	return EXCLUDED_DIRECTORY_NAMES.has(name)
		|| (parentName === JAVA_OUTPUT_PARENT && JAVA_OUTPUT_DIRECTORY_NAMES.has(name));
}

export function isExcludedRelativePath(relativePath: string): boolean {
	if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
		return false;
	}
	const directories = relativePath.split(/[\\/]/).slice(0, -1);
	return directories.some((name, index) => isExcludedDirectory(name, directories[index - 1] ?? ''));
}

export function isLinkedWorktreeGitFile(content: string): boolean {
	return LINKED_WORKTREE_GITDIR_RE.test(content);
}

export function isLinkedWorktreeRoot(directory: string): boolean {
	const gitPath = path.join(directory, '.git');
	try {
		return fs.statSync(gitPath).isFile() && isLinkedWorktreeGitFile(fs.readFileSync(gitPath, 'utf8'));
	} catch {
		return false;
	}
}

export function createNestedWorktreeFilter(workspaceRoots: readonly string[]): (filePath: string) => boolean {
	const roots = new Set(workspaceRoots.map(root => path.resolve(root)));
	const insideByDirectory = new Map<string, boolean>();
	const isInside = (directory: string): boolean => {
		const parent = path.dirname(directory);
		if (roots.has(directory) || parent === directory) {
			return false;
		}
		let inside = insideByDirectory.get(directory);
		if (inside === undefined) {
			inside = isLinkedWorktreeRoot(directory) || isInside(parent);
			insideByDirectory.set(directory, inside);
		}
		return inside;
	};
	return filePath => isInside(path.dirname(path.resolve(filePath)));
}
