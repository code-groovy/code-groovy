export const MAX_HIERARCHY_DEPTH = 12;

export interface ParsedType {
	simpleName: string;
	fqn: string;
	packageName: string;
	kind: 'class' | 'interface' | 'trait' | 'enum';
	sourcePath?: string;
}

const PACKAGE_RE = /^\s*package\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*;?\s*$/m;
const TYPE_RE = /^\s*(?:(?:public|protected|private|static|final|abstract|sealed|non-sealed)\s+)*(class|interface|trait|enum)\s+([A-Za-z_]\w*)\b/gm;

export function parseTypesFromSource(text: string, sourcePath?: string): ParsedType[] {
	const packageMatch = text.match(PACKAGE_RE);
	const packageName = packageMatch?.[1] ?? '';

	const types: ParsedType[] = [];
	TYPE_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = TYPE_RE.exec(text)) !== null) {
		const kind = match[1] as ParsedType['kind'];
		const simpleName = match[2];
		if (!simpleName || simpleName.includes('$')) {
			continue;
		}
		types.push({
			simpleName,
			packageName,
			fqn: packageName ? `${packageName}.${simpleName}` : simpleName,
			kind,
			sourcePath
		});
	}

	return types;
}

export function parsePackageName(text: string): string {
	return text.match(PACKAGE_RE)?.[1] ?? '';
}

export interface ImportEntry {
	fqn: string;
	alias?: string;
	wildcard: boolean;
	isStatic: boolean;
}

const IMPORT_RE = /^\s*import\s+(static\s+)?([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)(\s*\.\s*\*)?(?:\s+as\s+([A-Za-z_]\w*))?\s*;?\s*$/gm;
const ALIAS_SEPARATOR = ' as ';

export function parseImportEntries(text: string): ImportEntry[] {
	const entries: ImportEntry[] = [];
	IMPORT_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = IMPORT_RE.exec(text)) !== null) {
		entries.push({
			fqn: match[2].replace(/\s+/g, ''),
			...(match[4] ? { alias: match[4] } : {}),
			wildcard: Boolean(match[3]),
			isStatic: Boolean(match[1])
		});
	}
	return entries;
}

export function parseImports(text: string): string[] {
	return parseImportEntries(text)
		.filter(entry => !entry.isStatic)
		.map(entry => entry.wildcard ? `${entry.fqn}.*` : entry.alias ? `${entry.fqn}${ALIAS_SEPARATOR}${entry.alias}` : entry.fqn);
}

export function importedTypeName(imports: string[], visibleName: string): string | undefined {
	for (const entry of imports) {
		if (entry.endsWith('.*')) {
			continue;
		}
		const aliasAt = entry.indexOf(ALIAS_SEPARATOR);
		if (aliasAt >= 0) {
			if (entry.slice(aliasAt + ALIAS_SEPARATOR.length) === visibleName) {
				return entry.slice(0, aliasAt);
			}
		} else if (entry.endsWith(`.${visibleName}`)) {
			return entry;
		}
	}
	return undefined;
}

export function wildcardImportPackages(imports: string[]): string[] {
	return imports.filter(entry => entry.endsWith('.*')).map(entry => entry.slice(0, -2));
}

export function resolveTypeName(name: string, packageName: string, imports: string[], known?: string[]): string | undefined {
	if (name.includes('.')) {
		return name;
	}
	const imported = importedTypeName(imports, name);
	if (imported) {
		return imported;
	}
	const samePackage = packageName ? `${packageName}.${name}` : name;
	if (!known) {
		return packageName ? samePackage : undefined;
	}
	if (known.includes(samePackage)) {
		return samePackage;
	}
	const wildcard = wildcardImportPackages(imports).map(candidate => `${candidate}.${name}`).find(candidate => known.includes(candidate));
	if (wildcard) {
		return wildcard;
	}
	return known.length === 1 ? known[0] : undefined;
}

export function listExistingImports(text: string): Set<string> {
	return new Set(parseImportEntries(text).map(entry => entry.fqn));
}
