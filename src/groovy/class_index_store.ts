import { parseTypesFromSource } from './class_parser';

export const MAX_INDEXED_CLASSES = 50_000;
export const MAX_COMPLETION_RESULTS = 50;

export interface IndexedType {
	simpleName: string;
	fqn: string;
	source: 'workspace' | 'jar';
	sourcePath?: string;
	declarationLine?: number;
	declarationColumn?: number;
	extendsTypes?: string[];
	implementsTypes?: string[];
}

export function simpleNameFromFqn(fqn: string): string {
	const idx = fqn.lastIndexOf('.');
	return idx >= 0 ? fqn.slice(idx + 1) : fqn;
}

export function packageNameFromFqn(fqn: string): string {
	const idx = fqn.lastIndexOf('.');
	return idx >= 0 ? fqn.slice(0, idx) : '';
}

export function indexSourceText(text: string, sourcePath?: string): IndexedType[] {
	return parseTypesFromSource(text, sourcePath).map(type => ({
		simpleName: type.simpleName,
		fqn: type.fqn,
		source: 'workspace' as const,
		sourcePath
	}));
}

export function indexJarFqns(fqns: string[], jarPath?: string): IndexedType[] {
	return fqns.map(fqn => ({
		simpleName: simpleNameFromFqn(fqn),
		fqn,
		source: 'jar' as const,
		sourcePath: jarPath
	}));
}

export class ClassIndexStore {
	private readonly bySimpleName = new Map<string, IndexedType[]>();
	private readonly byFqn = new Map<string, IndexedType>();
	private count = 0;

	add(types: IndexedType[]): void {
		for (const type of types) {
			if (this.count >= MAX_INDEXED_CLASSES) {
				return;
			}
			const list = this.bySimpleName.get(type.simpleName) ?? [];
			if (list.some(existing => existing.fqn === type.fqn)) {
				continue;
			}
			list.push(type);
			this.bySimpleName.set(type.simpleName, list);
			this.byFqn.set(type.fqn, type);
			this.count += 1;
		}
	}

	remove(types: IndexedType[]): void {
		for (const type of types) {
			const list = this.bySimpleName.get(type.simpleName);
			const index = list?.findIndex(existing => existing.fqn === type.fqn && existing.sourcePath === type.sourcePath) ?? -1;
			if (!list || index < 0) {
				continue;
			}
			list.splice(index, 1);
			if (list.length === 0) {
				this.bySimpleName.delete(type.simpleName);
			}
			if (this.byFqn.get(type.fqn)?.sourcePath === type.sourcePath) {
				this.byFqn.delete(type.fqn);
			}
			this.count -= 1;
		}
	}

	lookupByFqn(fqn: string): IndexedType | undefined {
		return this.byFqn.get(fqn);
	}

	lookup(simpleName: string): IndexedType[] {
		return [...(this.bySimpleName.get(simpleName) ?? [])];
	}

	lookupPrefix(prefix: string, limit = MAX_COMPLETION_RESULTS): IndexedType[] {
		if (!prefix) {
			return [];
		}
		const lower = prefix.toLowerCase();
		const results: IndexedType[] = [];
		for (const [name, types] of this.bySimpleName) {
			if (name.toLowerCase().startsWith(lower)) {
				results.push(...types);
			}
		}
		results.sort((a, b) => compareTypeCompletions(a, b, lower));
		return results.slice(0, limit);
	}

	removeBySource(source: IndexedType['source']): void {
		for (const [name, types] of this.bySimpleName) {
			const kept = types.filter(type => type.source !== source);
			for (const type of types) {
				if (type.source === source) {
					this.byFqn.delete(type.fqn);
				}
			}
			this.count -= types.length - kept.length;
			if (kept.length === 0) {
				this.bySimpleName.delete(name);
			} else {
				this.bySimpleName.set(name, kept);
			}
		}
	}

	clear(): void {
		this.bySimpleName.clear();
		this.byFqn.clear();
		this.count = 0;
	}

	size(): number {
		return this.count;
	}

	countBySource(source: IndexedType['source']): number {
		let count = 0;
		for (const types of this.bySimpleName.values()) {
			for (const type of types) {
				if (type.source === source) {
					count += 1;
				}
			}
		}
		return count;
	}

	serialize(source: IndexedType['source']): Array<{ simpleName: string; fqn: string }> {
		const result: Array<{ simpleName: string; fqn: string }> = [];
		for (const types of this.bySimpleName.values()) {
			for (const type of types) {
				if (type.source === source) {
					result.push({ simpleName: type.simpleName, fqn: type.fqn });
				}
			}
		}
		return result;
	}
}

export function compareTypeCompletions(a: IndexedType, b: IndexedType, prefixLower: string): number {
	const aExact = a.simpleName.toLowerCase() === prefixLower ? 0 : 1;
	const bExact = b.simpleName.toLowerCase() === prefixLower ? 0 : 1;
	if (aExact !== bExact) {
		return aExact - bExact;
	}

	const aWorkspace = a.source === 'workspace' ? 0 : 1;
	const bWorkspace = b.source === 'workspace' ? 0 : 1;
	if (aWorkspace !== bWorkspace) {
		return aWorkspace - bWorkspace;
	}

	if (a.simpleName.length !== b.simpleName.length) {
		return a.simpleName.length - b.simpleName.length;
	}

	return a.simpleName.localeCompare(b.simpleName) || a.fqn.localeCompare(b.fqn);
}
