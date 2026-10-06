import * as fs from 'fs';
import * as path from 'path';
import { packageNameFromFqn, simpleNameFromFqn } from './class_index_store';
import { escapeRegExp } from './text_scan_logic';

const GRAILS_SOURCE_ROOTS = [
	'src/main/groovy',
	'grails-app/domain',
	'grails-app/controllers',
	'grails-app/services',
	'grails-app/taglib',
	'grails-app/jobs'
];

const MODULE_NAMES = ['domain', 'web', 'api', 'billing', 'core'];

/**
 * Resolves a workspace source file for an imported FQN when the index missed it
 * (e.g. large monorepos) using Grails multi-module path conventions.
 */
export function findGrailsSourceForFqn(fqn: string, workspaceRoot: string): string | undefined {
	const simpleName = simpleNameFromFqn(fqn);
	const packageName = packageNameFromFqn(fqn);
	const packagePath = packageName.replace(/\./g, '/');
	const fileNames = [`${simpleName}.groovy`, `${simpleName}.java`];

	const rootsToSearch = collectWorkspaceRoots(workspaceRoot);
	for (const root of rootsToSearch) {
		for (const sourceRoot of GRAILS_SOURCE_ROOTS) {
			for (const fileName of fileNames) {
				const candidate = path.join(root, sourceRoot, packagePath, fileName);
				if (matchesPackage(candidate, packageName)) {
					return candidate;
				}
			}
		}
		for (const fileName of fileNames) {
			const candidate = path.join(root, packagePath, fileName);
			if (matchesPackage(candidate, packageName)) {
				return candidate;
			}
		}
	}
	return undefined;
}

function collectWorkspaceRoots(workspaceRoot: string): string[] {
	const roots = new Set<string>([workspaceRoot]);
	const workspaceName = path.basename(workspaceRoot);

	for (const module of MODULE_NAMES) {
		const moduleRoot = path.join(workspaceRoot, module);
		if (fs.existsSync(moduleRoot) && fs.statSync(moduleRoot).isDirectory()) {
			roots.add(moduleRoot);
		}
	}

	if (MODULE_NAMES.includes(workspaceName)) {
		const monorepoRoot = path.dirname(workspaceRoot);
		roots.add(monorepoRoot);
		for (const module of MODULE_NAMES) {
			const siblingRoot = path.join(monorepoRoot, module);
			if (fs.existsSync(siblingRoot) && fs.statSync(siblingRoot).isDirectory()) {
				roots.add(siblingRoot);
			}
		}
	}

	return [...roots];
}

function matchesPackage(filePath: string, packageName: string): boolean {
	if (!fs.existsSync(filePath)) {
		return false;
	}
	if (!packageName) {
		return true;
	}
	try {
		const fd = fs.openSync(filePath, 'r');
		const buffer = Buffer.alloc(512);
		const bytesRead = fs.readSync(fd, buffer, 0, 512, 0);
		fs.closeSync(fd);
		const head = buffer.toString('utf8', 0, bytesRead);
		return new RegExp(`^package\\s+${escapeRegExp(packageName)}\\b`, 'm').test(head);
	} catch {
		return false;
	}
}
