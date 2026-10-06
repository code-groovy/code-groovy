import { analyzeDocument } from './call_site_extractor';
import { packageNameFromFqn, simpleNameFromFqn } from './class_index_store';
import { importedTypeName, MAX_HIERARCHY_DEPTH, parseImports, parsePackageName, wildcardImportPackages } from './class_parser';
import { ParsedDocumentSymbols } from './symbol_parser';

export interface MethodLocation {
	filePath: string;
	line: number;
	column: number;
}

export interface ListedMethod {
	name: string;
	filePath: string;
	line: number;
	column: number;
	className?: string;
}

export interface FieldMatch {
	filePath: string;
	line: number;
	column: number;
	typeName: string;
}

type ReadFile = (filePath: string) => string | undefined;
type FindEntries = (className: string) => Array<{ filePath: string; packageName?: string }>;

export function findMethodInText(content: string, methodName: string, className?: string, filePath?: string): MethodLocation[] {
	return listMethodsInText(content, className, filePath).filter(method => method.name === methodName).map(method => ({
		filePath: method.filePath,
		line: method.line,
		column: method.column
	}));
}

export function listMethodsInText(content: string, className?: string, filePath?: string): ListedMethod[] {
	const symbols = analyzeDocument(content, filePath).symbols;
	const ownClass = className ? classNamed(symbols, className) : undefined;
	return symbols.methods
		.filter(method => !ownClass || method.classFqn === ownClass.fqn)
		.map(method => ({
			name: method.name,
			filePath: '',
			line: method.line,
			column: method.column,
			className: simpleNameFromFqn(method.classFqn)
		}));
}

export function classParents(symbols: ParsedDocumentSymbols, className?: string): string[] {
	const ownClass = className ? classNamed(symbols, className) : symbols.classes[0];
	return [...(ownClass?.extendsTypes ?? []), ...(ownClass?.implementsTypes ?? [])].map(simpleNameFromFqn);
}

export function findMethodInClassHierarchy(
	readFile: ReadFile,
	findEntries: FindEntries,
	className: string,
	methodName: string,
	visited: Set<string> = new Set(),
	depth = 0,
	referencingContent?: string
): MethodLocation[] {
	return listMethodsInClassHierarchy(readFile, findEntries, className, visited, depth, referencingContent)
		.filter(method => method.name === methodName)
		.map(method => ({
			filePath: method.filePath,
			line: method.line,
			column: method.column
		}));
}

export function listMethodsInClassHierarchy(
	readFile: ReadFile,
	findEntries: FindEntries,
	className: string,
	visited: Set<string> = new Set(),
	depth = 0,
	referencingContent?: string
): ListedMethod[] {
	if (!className || depth > MAX_HIERARCHY_DEPTH) {
		return [];
	}

	const byName = new Map<string, ListedMethod>();
	const lineage: Array<{ parents: string[]; content: string }> = [];

	for (const entry of preferReferencedEntries(findEntries(className), className, readFile, referencingContent)) {
		if (visited.has(entry.filePath)) {
			continue;
		}
		visited.add(entry.filePath);
		const content = readFile(entry.filePath);
		if (!content) {
			continue;
		}

		for (const method of listMethodsInText(content, className, entry.filePath)) {
			if (!byName.has(method.name)) {
				byName.set(method.name, { ...method, filePath: entry.filePath, className });
			}
		}

		lineage.push({ parents: classParents(analyzeDocument(content, entry.filePath).symbols, className), content });
	}

	for (const { parents, content } of lineage) {
		for (const parent of parents) {
			for (const inherited of listMethodsInClassHierarchy(readFile, findEntries, parent, visited, depth + 1, content)) {
				if (!byName.has(inherited.name)) {
					byName.set(inherited.name, inherited);
				}
			}
		}
	}

	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findFieldInClassHierarchy(
	readFile: ReadFile,
	findEntries: FindEntries,
	className: string,
	fieldName: string,
	referencingContent?: string,
	visited: Set<string> = new Set(),
	depth = 0
): FieldMatch[] {
	if (!className || depth > MAX_HIERARCHY_DEPTH) {
		return [];
	}

	for (const entry of preferReferencedEntries(findEntries(className), className, readFile, referencingContent)) {
		if (visited.has(entry.filePath)) {
			continue;
		}
		visited.add(entry.filePath);
		const content = readFile(entry.filePath);
		if (!content) {
			continue;
		}
		const symbols = analyzeDocument(content, entry.filePath).symbols;
		const ownClass = classNamed(symbols, className);
		const constant = symbols.enumConstants.find(candidate => candidate.name === fieldName && candidate.enumFqn === ownClass?.fqn);
		if (constant) {
			return [{ filePath: entry.filePath, line: constant.line, column: constant.column, typeName: className }];
		}
		const field = symbols.fields.find(candidate => candidate.classMember && candidate.name === fieldName && candidate.classFqn === ownClass?.fqn);
		if (field) {
			return [{ filePath: entry.filePath, line: field.line, column: field.column, typeName: simpleNameFromFqn(field.typeName) }];
		}
		for (const parent of classParents(symbols, className)) {
			const inherited = findFieldInClassHierarchy(readFile, findEntries, parent, fieldName, content, visited, depth + 1);
			if (inherited.length > 0) {
				return inherited;
			}
		}
	}

	return [];
}

export function preferReferencedEntries<T extends { filePath: string; packageName?: string }>(
	entries: T[],
	className: string,
	readFile: ReadFile,
	referencingContent?: string
): T[] {
	if (entries.length <= 1 || !referencingContent) {
		return entries;
	}
	const imports = parseImports(referencingContent);
	const explicit = importedTypeName(imports, className);
	const candidatePackages = explicit
		? [packageNameFromFqn(explicit)]
		: [parsePackageName(referencingContent), ...wildcardImportPackages(imports)];
	for (const candidate of candidatePackages) {
		const matching = entries.filter(entry => (entry.packageName ?? parsePackageName(readFile(entry.filePath) ?? '')) === candidate);
		if (matching.length > 0) {
			return matching;
		}
	}
	return entries;
}

function classNamed(symbols: ParsedDocumentSymbols, className: string) {
	return symbols.classes.find(cls => cls.simpleName === className) ?? (symbols.classes.length === 1 ? symbols.classes[0] : undefined);
}
