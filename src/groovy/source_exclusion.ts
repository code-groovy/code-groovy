import * as path from 'path';

const EXCLUDED_DIRECTORY_NAMES = new Set(['node_modules', '.git', 'build', 'target', 'out']);
const JAVA_OUTPUT_PARENT = 'bin';
const JAVA_OUTPUT_DIRECTORY_NAMES = new Set(['main', 'test', 'default']);

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
