import { ClassIndexStore, IndexedType, simpleNameFromFqn } from './class_index_store';
import { parseImportEntries, parsePackageName } from './class_parser';

export interface ImportMap {
	bySimpleName: Map<string, string>;
	packageName: string;
}

export function buildImportMap(documentText: string): ImportMap {
	const packageName = parsePackageName(documentText);
	const bySimpleName = new Map<string, string>();
	for (const entry of parseImportEntries(documentText)) {
		if (!entry.wildcard) {
			bySimpleName.set(entry.alias ?? simpleNameFromFqn(entry.fqn), entry.fqn);
		}
	}
	return { bySimpleName, packageName };
}

export function resolveSimpleTypeName(
	simpleName: string,
	importMap: ImportMap,
	store: ClassIndexStore
): string[] {
	const fqns: string[] = [];
	if (importMap.bySimpleName.has(simpleName)) {
		fqns.push(importMap.bySimpleName.get(simpleName)!);
	}
	if (importMap.packageName) {
		fqns.push(`${importMap.packageName}.${simpleName}`);
	}
	for (const type of store.lookup(simpleName)) {
		if (!fqns.includes(type.fqn)) {
			fqns.push(type.fqn);
		}
	}
	return fqns;
}

export function rankTypeMatches(matches: IndexedType[], preferredPackage?: string): IndexedType[] {
	return [...matches].sort((a, b) => {
		const aWorkspace = a.source === 'workspace' ? 0 : 1;
		const bWorkspace = b.source === 'workspace' ? 0 : 1;
		if (aWorkspace !== bWorkspace) {
			return aWorkspace - bWorkspace;
		}
		if (preferredPackage) {
			const aPkg = a.fqn.startsWith(preferredPackage + '.') ? 0 : 1;
			const bPkg = b.fqn.startsWith(preferredPackage + '.') ? 0 : 1;
			if (aPkg !== bPkg) {
				return aPkg - bPkg;
			}
		}
		return a.fqn.localeCompare(b.fqn);
	});
}
