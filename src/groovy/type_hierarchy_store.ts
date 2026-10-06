import { packageNameFromFqn, simpleNameFromFqn } from './class_index_store';
import { importedTypeName, resolveTypeName } from './class_parser';
import { ParsedMethod } from './symbol_parser';

export interface HierarchyMember {
	classFqn: string;
	name: string;
	typeName?: string;
}

export interface HierarchyType {
	simpleName: string;
	fqn: string;
	sourcePath?: string;
	packageName?: string;
	extendsTypes?: string[];
	implementsTypes?: string[];
}

export interface MethodDeclaration {
	sourcePath: string;
	line: number;
	column: number;
}

interface PendingType {
	type: HierarchyType;
	imports: string[];
}

export class TypeHierarchyStore {
	private readonly pending: PendingType[] = [];
	private readonly fqnsBySimpleName = new Map<string, string[]>();
	private readonly parents = new Map<string, string[]>();
	private readonly children = new Map<string, string[]>();
	private readonly methodsByClass = new Map<string, ParsedMethod[]>();
	private readonly fieldTypesByClass = new Map<string, Map<string, string>>();
	private readonly enumConstantsByClass = new Map<string, Set<string>>();
	private readonly fileContexts = new Map<string, { packageName: string; imports: string[] }>();
	private readonly sourceByFqn = new Map<string, string>();
	private readonly typeInFileCache = new Map<string, string | undefined>();
	private resolved = true;

	add(
		types: HierarchyType[],
		methods: ParsedMethod[],
		imports: string[] = [],
		fields: HierarchyMember[] = [],
		enumConstants: HierarchyMember[] = []
	): void {
		for (const type of types) {
			this.pending.push({ type, imports });
			push(this.fqnsBySimpleName, type.simpleName, type.fqn);
			if (type.sourcePath) {
				this.sourceByFqn.set(type.fqn, type.sourcePath);
			}
			if (type.sourcePath && !this.fileContexts.has(type.sourcePath)) {
				this.fileContexts.set(type.sourcePath, { packageName: type.packageName ?? packageNameFromFqn(type.fqn), imports });
			}
		}
		for (const method of methods) {
			push(this.methodsByClass, method.classFqn, method);
		}
		for (const field of fields) {
			if (field.typeName) {
				const byName = this.fieldTypesByClass.get(field.classFqn) ?? new Map<string, string>();
				byName.set(field.name, field.typeName);
				this.fieldTypesByClass.set(field.classFqn, byName);
			}
		}
		for (const constant of enumConstants) {
			const names = this.enumConstantsByClass.get(constant.classFqn) ?? new Set<string>();
			names.add(constant.name);
			this.enumConstantsByClass.set(constant.classFqn, names);
		}
		this.resolved = false;
		this.typeInFileCache.clear();
	}

	removeFile(
		sourcePath: string,
		types: HierarchyType[],
		methods: ParsedMethod[],
		fields: HierarchyMember[] = [],
		enumConstants: HierarchyMember[] = []
	): void {
		const removedTypes = new Set(types);
		const kept = this.pending.filter(entry => !removedTypes.has(entry.type));
		this.pending.length = 0;
		this.pending.push(...kept);
		for (const type of types) {
			const fqns = this.fqnsBySimpleName.get(type.simpleName);
			const index = fqns?.indexOf(type.fqn) ?? -1;
			if (fqns && index >= 0) {
				fqns.splice(index, 1);
				if (fqns.length === 0) {
					this.fqnsBySimpleName.delete(type.simpleName);
				}
			}
			if (this.sourceByFqn.get(type.fqn) === sourcePath) {
				this.sourceByFqn.delete(type.fqn);
			}
		}
		const removedMethods = new Set(methods);
		for (const classFqn of new Set(methods.map(method => method.classFqn))) {
			const remaining = (this.methodsByClass.get(classFqn) ?? []).filter(method => !removedMethods.has(method));
			if (remaining.length > 0) {
				this.methodsByClass.set(classFqn, remaining);
			} else {
				this.methodsByClass.delete(classFqn);
			}
		}
		for (const field of fields) {
			this.fieldTypesByClass.get(field.classFqn)?.delete(field.name);
		}
		for (const constant of enumConstants) {
			this.enumConstantsByClass.get(constant.classFqn)?.delete(constant.name);
		}
		this.fileContexts.delete(sourcePath);
		this.typeInFileCache.clear();
		this.resolved = false;
	}

	memberType(fqn: string, memberName: string): string | undefined {
		if (this.enumConstantsByClass.get(fqn)?.has(memberName)) {
			return simpleNameFromFqn(fqn);
		}
		return this.fieldTypesByClass.get(fqn)?.get(memberName);
	}

	clear(): void {
		this.pending.length = 0;
		this.fqnsBySimpleName.clear();
		this.parents.clear();
		this.children.clear();
		this.methodsByClass.clear();
		this.fieldTypesByClass.clear();
		this.enumConstantsByClass.clear();
		this.fileContexts.clear();
		this.sourceByFqn.clear();
		this.typeInFileCache.clear();
		this.resolved = true;
	}

	sourceOf(fqn: string): string | undefined {
		return this.sourceByFqn.get(fqn);
	}

	resolveTypeIn(sourcePath: string, name: string): string | undefined {
		const key = `${sourcePath}\u0000${name}`;
		if (!this.typeInFileCache.has(key)) {
			const context = this.fileContexts.get(sourcePath);
			const visible = context ? importedTypeName(context.imports, name) ?? name : name;
			this.typeInFileCache.set(key, context
				? resolveTypeName(visible, context.packageName, context.imports, this.resolveClass(simpleNameFromFqn(visible)))
				: undefined);
		}
		return this.typeInFileCache.get(key);
	}

	resolveClass(simpleName: string): string[] {
		return this.fqnsBySimpleName.get(simpleName) ?? [];
	}

	parentsOf(fqn: string): string[] {
		this.resolve();
		return this.parents.get(fqn) ?? [];
	}

	childrenOf(fqn: string): string[] {
		this.resolve();
		return this.children.get(fqn) ?? [];
	}

	methodDeclarations(fqn: string, methodName: string): MethodDeclaration[] {
		return (this.methodsByClass.get(fqn) ?? [])
			.filter(method => method.name === methodName && method.sourcePath !== undefined)
			.map(method => ({ sourcePath: method.sourcePath as string, line: method.line, column: method.column }));
	}

	private resolve(): void {
		if (this.resolved) {
			return;
		}
		this.parents.clear();
		this.children.clear();
		for (const { type, imports } of this.pending) {
			for (const parentName of [...(type.extendsTypes ?? []), ...(type.implementsTypes ?? [])]) {
				const parent = this.resolveParent(parentName, type, imports);
				if (parent && parent !== type.fqn) {
					push(this.parents, type.fqn, parent);
					push(this.children, parent, type.fqn);
				}
			}
		}
		this.resolved = true;
	}

	private resolveParent(name: string, type: HierarchyType, imports: string[]): string | undefined {
		const visible = importedTypeName(imports, name) ?? name;
		return resolveTypeName(visible, type.packageName ?? packageNameFromFqn(type.fqn), imports, this.resolveClass(simpleNameFromFqn(visible)));
	}
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
	const list = map.get(key);
	if (list) {
		list.push(value);
	} else {
		map.set(key, [value]);
	}
}
