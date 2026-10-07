import * as vscode from 'vscode';
import { collectGrailsModuleSourceFiles, detectGrailsModules, GrailsModule } from './grails_module_detector';
import { createNestedWorktreeFilter, limitSourceFiles, SOURCE_EXCLUDE_GLOB } from './source_exclusion';

export interface SourceFileDiscovery {
	filePaths: string[];
	grailsModules: GrailsModule[];
}

let cachedDiscovery: Promise<SourceFileDiscovery> | undefined;

export function discoverSourceFiles(): Promise<SourceFileDiscovery> {
	cachedDiscovery ??= scanSourceFiles().catch(error => {
		cachedDiscovery = undefined;
		throw error;
	});
	return cachedDiscovery;
}

export function invalidateSourceFiles(): void {
	cachedDiscovery = undefined;
}

async function scanSourceFiles(): Promise<SourceFileDiscovery> {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	const configuration = vscode.workspace.getConfiguration('codeGroovy');
	const grailsModules = workspaceFolders
		? detectGrailsModules(workspaceFolders, configuration.get<string[]>('modules'))
		: [];
	if (grailsModules.length > 0) {
		return { filePaths: await collectGrailsModuleSourceFiles(grailsModules), grailsModules };
	}
	const maxFiles = configuration.get<number>('index.maxSourceFiles', 0);
	const files = await vscode.workspace.findFiles('**/*.{groovy,java}', SOURCE_EXCLUDE_GLOB);
	return { filePaths: limitSourceFiles(files.map(file => file.fsPath), createWorkspaceWorktreeFilter(), maxFiles), grailsModules };
}

export function createWorkspaceWorktreeFilter(): (filePath: string) => boolean {
	return createNestedWorktreeFilter((vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath));
}
