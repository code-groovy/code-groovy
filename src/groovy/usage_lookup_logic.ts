import * as path from 'path';
import { analyzeDocument, CallSiteRecord, receiverAt, receiverBefore, receiverChain, resolveChainRootType, resolveReceiverType } from './call_site_extractor';
import { simpleNameFromFqn } from './class_index_store';
import { MAX_HIERARCHY_DEPTH, parseImports, resolveTypeName } from './class_parser';
import { getterNamesForProperty, isPropertyRead, PropertyScan, propertyNameForGetter } from './property_access_logic';
import { classNameForBean, grailsFieldNameForClass } from './service_bean';
import { ParsedClassSymbol } from './symbol_parser';
import { MethodDeclaration } from './type_hierarchy_store';

export type UsageTarget =
	| { kind: 'class'; name: string; classFqn?: string }
	| { kind: 'method'; name: string; className: string; classFqn?: string; chain?: ReceiverChain }
	| { kind: 'constant'; name: string; typeName: string; typeFqn?: string };

export interface ReceiverChain {
	rootType: string;
	path: string[];
}

export interface UsageLookupIndex {
	lookup(methodName: string): CallSiteRecord[];
	lookupByReceiver(receiverName: string): CallSiteRecord[];
	filesMentioning(typeName: string): string[];
	isReady(): boolean;
}

export interface UsageHierarchy {
	resolveClass(simpleName: string): string[];
	parentsOf(fqn: string): string[];
	childrenOf(fqn: string): string[];
	methodDeclarations(fqn: string, methodName: string): MethodDeclaration[];
	memberType?(fqn: string, memberName: string): string | undefined;
	resolveTypeIn?(sourcePath: string, name: string): string | undefined;
	sourceOf?(fqn: string): string | undefined;
}

interface UsageScope {
	classNames: Set<string>;
	classFqns: Set<string>;
	typeIn?: (sourcePath: string, name: string) => string | undefined;
	superCallerNames: Set<string>;
	fieldNames: Set<string>;
	ancestorsDeclaring: string[];
	resolveChain?: (rootType: string, path: string[]) => string | undefined;
}

export type TextScan =
	| { scope: 'workspace'; receiverFieldName?: string }
	| { scope: 'files'; files: string[]; receiverFieldName?: string };

export interface UsageResolution {
	records: CallSiteRecord[];
	textScans: TextScan[];
	superDeclarations: MethodDeclaration[];
	propertyScans?: PropertyScan[];
}

export interface UsageLocation {
	sourcePath: string;
	line: number;
	column: number;
	length: number;
}

export interface SourcePosition {
	sourcePath: string;
	line: number;
	column: number;
}

export type WordScanner = (word: string, scan: TextScan) => Promise<UsageLocation[]>;

export type PropertyScanner = (scan: PropertyScan) => Promise<UsageLocation[]>;

export type UsageMode = 'navigate' | 'references';

const CONSTANT_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

export function findDeclarationTarget(
	documentText: string,
	sourcePath: string,
	line: number,
	word: string,
	wordStart?: number
): UsageTarget | undefined {
	const symbols = analyzeDocument(documentText, sourcePath).symbols;
	const atWord = (column: number) => wordStart === undefined || column === wordStart;
	const declaredClass = symbols.classes.find(cls => cls.line === line && cls.simpleName === word && atWord(cls.column));
	if (declaredClass) {
		return { kind: 'class', name: word, classFqn: declaredClass.fqn };
	}
	const constructor = symbols.constructors.find(candidate => candidate.line === line && atWord(candidate.column)
		&& simpleNameFromFqn(candidate.classFqn) === word);
	if (constructor) {
		return { kind: 'class', name: word, classFqn: constructor.classFqn };
	}
	const method = symbols.methods.find(candidate => candidate.line === line && candidate.name === word && atWord(candidate.column));
	if (!method) {
		return undefined;
	}
	const className = simpleNameFromFqn(method.classFqn);
	if (word === className) {
		return { kind: 'class', name: word, classFqn: method.classFqn };
	}
	return { kind: 'method', name: word, className, classFqn: method.classFqn };
}

export function isDeclarationAt(documentText: string, sourcePath: string, line: number, word: string, wordStart: number): boolean {
	if (findDeclarationTarget(documentText, sourcePath, line, word, wordStart)) {
		return true;
	}
	const symbols = analyzeDocument(documentText, sourcePath).symbols;
	return symbols.enumConstants.some(constant => constant.line === line && constant.column === wordStart && constant.name === word)
		|| symbols.fields.some(field => field.classMember && field.line === line && field.column === wordStart && field.name === word);
}

export function findReferenceTarget(
	documentText: string,
	sourcePath: string,
	line: number,
	wordStart: number,
	word: string,
	hierarchy?: UsageHierarchy
): UsageTarget | undefined {
	const declaration = findDeclarationTarget(documentText, sourcePath, line, word, wordStart);
	if (declaration) {
		return declaration;
	}
	const constant = constantTargetAt(documentText, sourcePath, line, wordStart, word, hierarchy);
	if (constant) {
		return constant;
	}
	if (/^[A-Z]/.test(word)) {
		const classFqn = hierarchy?.resolveTypeIn?.(sourcePath, word);
		return { kind: 'class', name: word, ...(classFqn ? { classFqn } : {}) };
	}

	const analysis = analyzeDocument(documentText, sourcePath);
	const maskedText = analysis.maskedText;
	const lineText = analysis.maskedLines[line] ?? '';
	const lineStart = analysis.lineStarts[line] ?? maskedText.length;
	const receiverMatch = lineText.slice(0, wordStart).match(/([A-Za-z_]\w*)\s*[?*]?\.\s*$/);
	const previous = receiverMatch ? undefined : receiverBefore(maskedText, lineStart + wordStart);
	if (previous?.kind === 'chain') {
		return undefined;
	}
	const receiver = receiverMatch?.[1] ?? previous?.name;
	const after = lineText.slice(wordStart + word.length);
	const isCall = /^\s*\(/.test(after) || (receiver !== undefined && /^\s*\{/.test(after));
	if (!isCall) {
		return receiverMatch && receiverMatch.index !== undefined && isPropertyRead(lineText, wordStart + word.length)
			? getterTargetAt(documentText, sourcePath, line, lineStart + receiverMatch.index, receiverMatch[1], word, hierarchy)
			: undefined;
	}
	if (receiver === 'super') {
		const owner = analysis.owners[line];
		const parent = owner?.extendsTypes[0] ?? owner?.implementsTypes[0];
		if (!owner || !parent) {
			return undefined;
		}
		const parentFqn = hierarchy?.parentsOf(owner.fqn).find(candidate => simpleNameFromFqn(candidate) === simpleNameFromFqn(parent))
			?? resolveTypeName(parent, owner.packageName, parseImports(documentText));
		return { kind: 'method', name: word, className: simpleNameFromFqn(parent), ...(parentFqn ? { classFqn: parentFqn } : {}) };
	}
	const chain = receiverMatch && receiverMatch.index !== undefined
		? receiverChain(maskedText, lineStart + receiverMatch.index, receiverMatch[1])
		: undefined;
	if (chain) {
		const rootType = resolveChainRootType(documentText, line, chain[0], sourcePath);
		return {
			kind: 'method',
			name: word,
			className: classNameForBean(chain[chain.length - 1]),
			...(rootType ? { chain: { rootType, path: chain.slice(1) } } : {})
		};
	}
	if (receiver && receiver !== 'this') {
		return { kind: 'method', name: word, className: receiverClassName(documentText, sourcePath, line, receiver) };
	}
	return { kind: 'method', name: word, className: owningClassName(documentText, sourcePath, line) };
}

export function resolveUsages(
	target: UsageTarget,
	index: UsageLookupIndex,
	mode: UsageMode,
	hierarchy?: UsageHierarchy
): UsageResolution {
	if (target.kind === 'constant') {
		return resolveConstantUsages(target, index, hierarchy);
	}
	if (target.kind === 'class') {
		const refersToTarget = classReferenceFilter(target, hierarchy);
		const records = uniqueRecords([
			...index.lookupByReceiver(target.name).filter(record => refersToTarget(record.sourcePath)),
			...index.lookup(target.name).filter(record => refersToTarget(record.sourcePath)),
			...(target.name.endsWith('Service') ? index.lookupByReceiver(grailsFieldNameForClass(target.name)) : [])
		]);
		if (mode === 'navigate' && records.length > 0) {
			return { records, textScans: [], superDeclarations: [] };
		}
		if (!index.isReady()) {
			return { records, textScans: [{ scope: 'workspace' }], superDeclarations: [] };
		}
		const files = index.filesMentioning(target.name).filter(refersToTarget);
		return { records, textScans: files.length > 0 ? [{ scope: 'files', files }] : [], superDeclarations: [] };
	}

	const chainType = target.chain && hierarchy?.memberType
		? chainResolver(hierarchy)(target.chain.rootType, target.chain.path)
		: undefined;
	const scope = buildScope(chainType ? { name: target.name, className: chainType } : target, hierarchy);
	const records = index.lookup(target.name).filter(record => isScopedCall(record, scope));
	const propertyScans = propertyScansFor(target.name, scope, index, hierarchy);
	const superDeclarations = records.length > 0 || !hierarchy
		? []
		: scope.ancestorsDeclaring.flatMap(ancestor => hierarchy.methodDeclarations(ancestor, target.name));
	if (records.length > 0 || index.isReady()) {
		return { records, textScans: [], superDeclarations, ...(propertyScans.length > 0 ? { propertyScans } : {}) };
	}
	return { records, textScans: [{ scope: 'workspace', receiverFieldName: grailsFieldNameForClass(target.className) }], superDeclarations };
}

export async function collectUsageLocations(
	target: UsageTarget,
	resolution: UsageResolution,
	mode: UsageMode,
	word: string,
	scanWord: WordScanner,
	declaration?: SourcePosition,
	scanProperties?: PropertyScanner
): Promise<UsageLocation[]> {
	let locations = resolution.records.map(record => recordLocation(record, target));
	const needsScan = mode === 'references' ? target.kind !== 'method' || locations.length === 0 : locations.length === 0;
	if (resolution.textScans.length > 0 && needsScan) {
		const scanned = uniqueLocations((await Promise.all(resolution.textScans.map(scan => scanWord(word, scan)))).flat());
		locations = mode === 'references' && target.kind === 'class' ? mergeByLine(scanned, locations) : scanned;
	}
	if (scanProperties && resolution.propertyScans && resolution.propertyScans.length > 0) {
		const reads = (await Promise.all(resolution.propertyScans.map(scanProperties))).flat();
		locations = uniqueLocations([...locations, ...reads]);
	}
	const usages = declaration ? locations.filter(location => !isAtPosition(location, declaration)) : locations;
	if (usages.length > 0) {
		return usages;
	}
	return resolution.superDeclarations.map(superDeclaration => ({
		sourcePath: superDeclaration.sourcePath,
		line: superDeclaration.line,
		column: superDeclaration.column,
		length: word.length
	}));
}

export function declarationLocations(target: UsageTarget, word: string, hierarchy?: UsageHierarchy): UsageLocation[] {
	if (target.kind !== 'method' || !hierarchy) {
		return [];
	}
	const chainType = target.chain && hierarchy.memberType
		? chainResolver(hierarchy)(target.chain.rootType, target.chain.path)
		: undefined;
	const known = hierarchy.resolveClass(chainType ?? target.className);
	const roots = target.classFqn && known.includes(target.classFqn) ? [target.classFqn] : known;
	const toLocation = (declaration: MethodDeclaration) => ({ ...declaration, length: target.name.length });
	const own = roots.flatMap(fqn => hierarchy.methodDeclarations(fqn, target.name));
	if (own.length > 0) {
		return own.map(toLocation);
	}
	for (const ancestor of walkHierarchy(roots, fqn => hierarchy.parentsOf(fqn))) {
		const inherited = hierarchy.methodDeclarations(ancestor, target.name);
		if (inherited.length > 0) {
			return inherited.map(toLocation);
		}
	}
	return [];
}

export function recordLocation(record: CallSiteRecord, target: UsageTarget): UsageLocation {
	if (target.kind === 'class' && record.methodName !== target.name && record.receiverName && record.receiverColumn !== undefined) {
		return {
			sourcePath: record.sourcePath,
			line: record.receiverLine ?? record.line,
			column: record.receiverColumn,
			length: record.receiverName.length
		};
	}
	return { sourcePath: record.sourcePath, line: record.line, column: record.column, length: record.methodName.length };
}

export function excludePosition<T extends { line: number; column: number }>(
	targets: Array<T & { uri: string }>,
	position: SourcePosition
): Array<T & { uri: string }> {
	return targets.filter(target => !isAtPosition({ sourcePath: target.uri, line: target.line, column: target.column }, position));
}

function isAtPosition(location: SourcePosition, position: SourcePosition): boolean {
	return location.sourcePath === position.sourcePath && location.line === position.line && location.column === position.column;
}

function uniqueLocations(locations: UsageLocation[]): UsageLocation[] {
	const seen = new Set<string>();
	return locations.filter(location => {
		const key = `${location.sourcePath}::${location.line}::${location.column}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

function constantTargetAt(
	documentText: string,
	sourcePath: string,
	line: number,
	wordStart: number,
	word: string,
	hierarchy?: UsageHierarchy
): UsageTarget | undefined {
	if (!CONSTANT_NAME_RE.test(word)) {
		return undefined;
	}
	const analysis = analyzeDocument(documentText, sourcePath);
	const declared = analysis.symbols.enumConstants.find(constant => constant.line === line && constant.column === wordStart && constant.name === word)
		?? analysis.symbols.fields.find(field => field.classMember && field.line === line && field.column === wordStart && field.name === word);
	if (declared) {
		const typeFqn = 'enumFqn' in declared ? declared.enumFqn : declared.classFqn;
		return { kind: 'constant', name: word, typeName: simpleNameFromFqn(typeFqn), typeFqn };
	}
	const receiver = receiverAt(analysis.maskedText, (analysis.lineStarts[line] ?? 0) + wordStart);
	if (receiver.kind === 'name' && /^[A-Z]/.test(receiver.name)) {
		const typeFqn = hierarchy?.resolveTypeIn?.(sourcePath, receiver.name);
		return { kind: 'constant', name: word, typeName: receiver.name, ...(typeFqn ? { typeFqn } : {}) };
	}
	const ownConstant = receiver.kind === 'none'
		? analysis.symbols.enumConstants.find(constant => constant.name === word)
		: undefined;
	return ownConstant
		? { kind: 'constant', name: word, typeName: simpleNameFromFqn(ownConstant.enumFqn), typeFqn: ownConstant.enumFqn }
		: undefined;
}

function resolveConstantUsages(target: { name: string; typeName: string; typeFqn?: string }, index: UsageLookupIndex, hierarchy?: UsageHierarchy): UsageResolution {
	const declaringFile = target.typeFqn ? hierarchy?.sourceOf?.(target.typeFqn) : undefined;
	if (!index.isReady()) {
		return { records: [], textScans: [{ scope: 'workspace', receiverFieldName: target.typeName }], superDeclarations: [] };
	}
	const refersToType = classReferenceFilter({ name: target.typeName, classFqn: target.typeFqn }, hierarchy);
	const files = index.filesMentioning(target.typeName).filter(refersToType);
	return {
		records: [],
		textScans: [
			...(files.length > 0 ? [{ scope: 'files' as const, files, receiverFieldName: target.typeName }] : []),
			...(declaringFile ? [{ scope: 'files' as const, files: [declaringFile] }] : [])
		],
		superDeclarations: []
	};
}

function mergeByLine(primary: UsageLocation[], secondary: UsageLocation[]): UsageLocation[] {
	const lineKey = (location: UsageLocation) => `${location.sourcePath}::${location.line}`;
	const covered = new Set(primary.map(lineKey));
	return [...primary, ...secondary.filter(location => !covered.has(lineKey(location)))];
}

function classReferenceFilter(target: { name: string; classFqn?: string }, hierarchy: UsageHierarchy | undefined): (sourcePath: string) => boolean {
	const typeIn = hierarchy?.resolveTypeIn?.bind(hierarchy);
	if (!target.classFqn || !typeIn || !hierarchy || hierarchy.resolveClass(target.name).length < 2) {
		return () => true;
	}
	return sourcePath => {
		const resolved = typeIn(sourcePath, target.name);
		return resolved === undefined || resolved === target.classFqn;
	};
}

function buildScope(target: { name: string; className: string; classFqn?: string }, hierarchy: UsageHierarchy | undefined): UsageScope {
	const known = hierarchy ? hierarchy.resolveClass(target.className) : [];
	const roots = target.classFqn && known.includes(target.classFqn) ? [target.classFqn] : known;
	const ancestorsDeclaring = hierarchy
		? walkHierarchy(roots, fqn => hierarchy.parentsOf(fqn)).filter(fqn => hierarchy.methodDeclarations(fqn, target.name).length > 0)
		: [];
	const subclasses = new Set<string>();
	const superCallerNames = new Set<string>();
	if (hierarchy) {
		walkHierarchy(roots, fqn => hierarchy.childrenOf(fqn).filter(child => {
			superCallerNames.add(simpleNameFromFqn(child));
			if (hierarchy.methodDeclarations(child, target.name).length > 0) {
				return false;
			}
			subclasses.add(child);
			return true;
		}));
	}
	const classFqns = new Set([...roots, ...ancestorsDeclaring, ...subclasses]);
	const classNames = new Set([target.className, ...[...classFqns].map(simpleNameFromFqn)]);
	const homonymous = hierarchy !== undefined && [...classNames].some(name => hierarchy.resolveClass(name).length > 1);
	return {
		classNames,
		classFqns,
		...(homonymous && hierarchy?.resolveTypeIn ? { typeIn: hierarchy.resolveTypeIn.bind(hierarchy) } : {}),
		superCallerNames,
		fieldNames: new Set([...classNames].map(grailsFieldNameForClass)),
		ancestorsDeclaring,
		resolveChain: hierarchy?.memberType ? chainResolver(hierarchy) : undefined
	};
}

function chainResolver(hierarchy: UsageHierarchy): (rootType: string, path: string[]) => string | undefined {
	const cache = new Map<string, string | undefined>();
	const memberTypeOf = (typeName: string, memberName: string): string | undefined => {
		const key = `${typeName}#${memberName}`;
		if (!cache.has(key)) {
			const roots = hierarchy.resolveClass(typeName);
			const candidates = [...roots, ...walkHierarchy(roots, fqn => hierarchy.parentsOf(fqn))];
			const found = candidates.map(fqn => hierarchy.memberType?.(fqn, memberName)).find(Boolean);
			cache.set(key, found ? simpleNameFromFqn(found) : undefined);
		}
		return cache.get(key);
	};
	return (rootType, path) => {
		let typeName: string | undefined = rootType;
		for (const segment of path) {
			typeName = typeName ? memberTypeOf(typeName, segment) : undefined;
		}
		return typeName;
	};
}

function walkHierarchy(roots: string[], next: (fqn: string) => string[]): string[] {
	const found = new Set<string>();
	let frontier = roots;
	for (let depth = 0; depth < MAX_HIERARCHY_DEPTH && frontier.length > 0; depth++) {
		const following: string[] = [];
		for (const fqn of frontier) {
			for (const related of next(fqn)) {
				if (!found.has(related) && !roots.includes(related)) {
					found.add(related);
					following.push(related);
				}
			}
		}
		frontier = following;
	}
	return [...found];
}

export function uniqueRecords(records: CallSiteRecord[]): CallSiteRecord[] {
	const seen = new Set<string>();
	return records.filter(record => {
		const key = `${record.sourcePath}::${record.line}::${record.column}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

function isScopedCall(record: CallSiteRecord, scope: UsageScope): boolean {
	if (record.receiverKind === 'chain') {
		return false;
	}
	const ownerFqn = record.ownerClass;
	const owner = ownerFqn ? simpleNameFromFqn(ownerFqn) : fileClassName(record.sourcePath);
	if (record.receiverName === undefined || record.receiverName === 'this') {
		return scope.classNames.has(owner) && (!scope.typeIn || !ownerFqn || scope.classFqns.has(ownerFqn));
	}
	if (record.receiverName === 'super') {
		return scope.superCallerNames.has(owner);
	}
	if (record.receiverRootType && record.receiverPath && scope.resolveChain) {
		const chainType = scope.resolveChain(record.receiverRootType, record.receiverPath);
		if (chainType) {
			return scope.classNames.has(chainType);
		}
	}
	if (record.receiverType) {
		return isScopedType(record.sourcePath, record.receiverType, scope);
	}
	if (/^[A-Z]/.test(record.receiverName)) {
		return isScopedType(record.sourcePath, record.receiverName, scope);
	}
	return scope.fieldNames.has(record.receiverName);
}

function isScopedType(sourcePath: string, typeName: string, scope: UsageScope): boolean {
	if (!scope.classNames.has(simpleNameFromFqn(typeName))) {
		return false;
	}
	const resolved = scope.typeIn?.(sourcePath, typeName);
	return resolved === undefined || scope.classFqns.has(resolved);
}

function propertyScansFor(
	methodName: string,
	scope: UsageScope,
	index: UsageLookupIndex,
	hierarchy: UsageHierarchy | undefined
): PropertyScan[] {
	const propertyName = propertyNameForGetter(methodName);
	if (!propertyName || !index.isReady()) {
		return [];
	}
	const files = new Set<string>();
	for (const className of scope.classNames) {
		for (const file of index.filesMentioning(className)) {
			files.add(file);
		}
	}
	for (const fqn of scope.classFqns) {
		const declaringFile = hierarchy?.sourceOf?.(fqn);
		if (declaringFile) {
			files.add(declaringFile);
		}
	}
	if (files.size === 0) {
		return [];
	}
	const readsOwnField = (read: CallSiteRecord) => read.receiverName === 'this' && read.ownerClass !== undefined
		&& hierarchy?.memberType?.(read.ownerClass, propertyName) !== undefined;
	return [{ scope: 'properties', propertyName, files: [...files], accepts: read => !readsOwnField(read) && isScopedPropertyRead(read, scope) }];
}

function isScopedPropertyRead(read: CallSiteRecord, scope: UsageScope): boolean {
	if (read.receiverKind === 'chain') {
		return false;
	}
	if (read.receiverName === 'this') {
		const owner = read.ownerClass;
		return owner !== undefined && scope.classNames.has(simpleNameFromFqn(owner)) && (!scope.typeIn || scope.classFqns.has(owner));
	}
	if (read.receiverRootType && read.receiverPath && scope.resolveChain) {
		const chainType = scope.resolveChain(read.receiverRootType, read.receiverPath);
		return chainType !== undefined && scope.classNames.has(chainType);
	}
	if (read.receiverType) {
		return isScopedType(read.sourcePath, read.receiverType, scope);
	}
	return read.receiverName !== undefined && /^[A-Z]/.test(read.receiverName) && isScopedType(read.sourcePath, read.receiverName, scope);
}

function getterTargetAt(
	documentText: string,
	sourcePath: string,
	line: number,
	receiverOffset: number,
	receiver: string,
	propertyName: string,
	hierarchy: UsageHierarchy | undefined
): UsageTarget | undefined {
	if (!hierarchy) {
		return undefined;
	}
	const analysis = analyzeDocument(documentText, sourcePath);
	const chain = receiverChain(analysis.maskedText, receiverOffset, receiver);
	let className: string | undefined;
	if (chain) {
		const rootType = resolveChainRootType(documentText, line, chain[0], sourcePath);
		className = rootType && hierarchy.memberType ? chainResolver(hierarchy)(rootType, chain.slice(1)) : undefined;
	} else if (receiver === 'this') {
		className = analysis.owners[line]?.simpleName;
	} else if (/^[A-Z]/.test(receiver)) {
		className = receiver;
	} else {
		const declared = analysis.resolveType(receiver, line);
		className = declared ? simpleNameFromFqn(declared) : undefined;
	}
	if (!className) {
		return undefined;
	}
	const roots = hierarchy.resolveClass(className);
	const searched = [...roots, ...walkHierarchy(roots, fqn => hierarchy.parentsOf(fqn))];
	if (searched.some(fqn => hierarchy.memberType?.(fqn, propertyName) !== undefined)) {
		return undefined;
	}
	const getter = getterNamesForProperty(propertyName)
		.find(name => searched.some(fqn => hierarchy.methodDeclarations(fqn, name).length > 0));
	return getter ? { kind: 'method', name: getter, className } : undefined;
}

function receiverClassName(documentText: string, sourcePath: string, line: number, receiver: string): string {
	return resolveReceiverType(documentText, line, receiver, sourcePath) ?? classNameForBean(receiver);
}

function owningClassName(documentText: string, sourcePath: string, line: number): string {
	return owningClass(documentText, sourcePath, line)?.simpleName ?? fileClassName(sourcePath);
}

function owningClass(documentText: string, sourcePath: string, line: number): ParsedClassSymbol | undefined {
	return analyzeDocument(documentText, sourcePath).owners[line];
}


function fileClassName(sourcePath: string): string {
	return path.basename(sourcePath, path.extname(sourcePath));
}
