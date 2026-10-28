import * as fs from 'fs';
import * as path from 'path';
import { isExcludedDirectory, isLinkedWorktreeRoot } from './source_exclusion';

export interface GrailsModule {
	name: string;
	rootPath: string;
	grailsAppPath: string;
	sourcePaths: string[];
}

const DEFAULT_MODULES = ['domain', 'web', 'api'];

export function detectGrailsModules(
	workspaceFolders: readonly { uri: { fsPath: string } }[],
	configuredModules: string[] = DEFAULT_MODULES
): GrailsModule[] {
	const modules: GrailsModule[] = [];
	const seen = new Set<string>();

	for (const folder of workspaceFolders) {
		collectModulesFromRoot(folder.uri.fsPath, configuredModules, modules, seen);
	}

	if (modules.length === 0) {
		const monorepoRoot = findGrailsMonorepoRoot(workspaceFolders);
		if (monorepoRoot) {
			collectModulesFromRoot(monorepoRoot, configuredModules, modules, seen);
		}
	}

	return modules;
}

export function findGrailsMonorepoRoot(workspaceFolders: readonly { uri: { fsPath: string } }[]): string | undefined {
	for (const folder of workspaceFolders) {
		const settingsGradle = path.join(folder.uri.fsPath, 'settings.gradle');
		if (fs.existsSync(settingsGradle)) {
			return folder.uri.fsPath;
		}

	}

	for (const folder of workspaceFolders) {
		let current = folder.uri.fsPath;
		for (let depth = 0; depth < 5; depth++) {
			const settingsGradle = path.join(current, 'settings.gradle');
			if (fs.existsSync(settingsGradle)) {
				const content = fs.readFileSync(settingsGradle, 'utf8');
				if (content.includes('include "domain"') || content.includes("include 'domain'")) {
					return current;
				}
			}
			const parent = path.dirname(current);
			if (parent === current) {
				break;
			}
			current = parent;
		}
	}

	return undefined;
}

function collectModulesFromRoot(
	rootPath: string,
	configured: string[],
	modules: GrailsModule[],
	seen: Set<string>
): void {
	const settingsGradle = path.join(rootPath, 'settings.gradle');
	if (fs.existsSync(settingsGradle)) {
		for (const moduleName of configured) {
			addModuleIfExists(rootPath, moduleName, modules, seen);
		}
		return;
	}

	if (configured.includes(path.basename(rootPath))) {
		addModuleFromPath(rootPath, path.basename(rootPath), modules, seen);
	}
}

function addModuleIfExists(
	repoRoot: string,
	moduleName: string,
	modules: GrailsModule[],
	seen: Set<string>
): void {
	const modulePath = path.join(repoRoot, moduleName);
	if (fs.existsSync(modulePath)) {
		addModuleFromPath(modulePath, moduleName, modules, seen);
	}
}

function addModuleFromPath(modulePath: string, moduleName: string, modules: GrailsModule[], seen: Set<string>): void {
	const normalized = path.normalize(modulePath);
	if (seen.has(normalized)) {
		return;
	}

	const grailsAppPath = path.join(normalized, 'grails-app');
	const candidatePaths = [
		grailsAppPath,
		path.join(normalized, 'src', 'main', 'groovy'),
		path.join(normalized, 'src', 'main', 'java'),
		path.join(normalized, 'src', 'test', 'groovy'),
		path.join(normalized, 'src', 'test', 'java'),
		path.join(normalized, 'src', 'integration-test', 'groovy'),
		path.join(normalized, 'src', 'integration-test', 'java')
	];

	if (!candidatePaths.some(candidate => fs.existsSync(candidate))) {
		return;
	}

	const sourcePaths = candidatePaths.filter(candidate => fs.existsSync(candidate));
	seen.add(normalized);
	modules.push({
		name: moduleName,
		rootPath: normalized,
		grailsAppPath,
		sourcePaths
	});
}

export async function collectGrailsModuleSourceFiles(modules: GrailsModule[]): Promise<string[]> {
	const perDirectory = await Promise.all(modules.flatMap(module => module.sourcePaths).map(collectSourceFilesFromDirectory));
	return perDirectory.flat();
}

export async function collectSourceFilesFromDirectory(dirPath: string): Promise<string[]> {
	const files: string[] = [];
	let frontier = [dirPath];
	while (frontier.length > 0) {
		const next: string[] = [];
		await Promise.all(frontier.map(async current => {
			let entries: fs.Dirent[];
			try {
				entries = await fs.promises.readdir(current, { withFileTypes: true });
			} catch {
				return;
			}
			if (current !== dirPath && entries.some(entry => entry.name === '.git' && entry.isFile()) && isLinkedWorktreeRoot(current)) {
				return;
			}
			for (const entry of entries) {
				const fullPath = path.join(current, entry.name);
				if (entry.isDirectory()) {
					if (!isExcludedDirectory(entry.name, path.basename(current))) {
						next.push(fullPath);
					}
				} else if (entry.name.endsWith('.groovy') || entry.name.endsWith('.java')) {
					files.push(fullPath);
				}
			}
		}));
		frontier = next;
	}
	return files.sort();
}
