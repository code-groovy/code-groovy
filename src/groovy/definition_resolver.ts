import * as fs from 'fs';
import { analyzeDocument, DocumentAnalysis, ReceiverAt, receiverAt, resolveChainRootType } from './call_site_extractor';
import { ClassIndexStore, packageNameFromFqn, simpleNameFromFqn } from './class_index_store';
import { parseImportEntries, parseImports, parsePackageName, resolveTypeName } from './class_parser';
import { resolveDeclarationPosition } from './declaration_position';
import { findGrailsSourceForFqn } from './fqn_source_resolver';
import { declaresNoParameters, getterNamesForProperty, isPropertyRead } from './property_access_logic';
import { GrailsArtifactIndex } from './grails_artifact_index';
import { findFieldInClassHierarchy, findMethodInClassHierarchy, preferReferencedEntries } from './method_navigation_logic';
import { candidateClassNamesForReceiver, serviceBeanToClassName } from './service_bean';
import { resolveJarTypeDefinition } from './sources_jar_resolver';
import { ParsedClassSymbol, ParsedDocumentSymbols, ParsedEnumConstant, ParsedMethod } from './symbol_parser';
import { escapeRegExp, splitLines } from './text_scan_logic';
import { buildImportMap, rankTypeMatches, resolveSimpleTypeName } from './type_resolver';

export interface DefinitionTarget {
	uri: string;
	line: number;
	column: number;
	label?: string;
}

export interface DefinitionContext {
	documentText: string;
	line: number;
	character: number;
	word: string;
	wordStart: number;
	sourcePath: string;
	workspaceRoot?: string;
	classpathJars?: string[];
	classStore: ClassIndexStore;
	artifactIndex: GrailsArtifactIndex;
}

export function resolveDefinitions(context: DefinitionContext): DefinitionTarget[] {
	const analysis = analyzeDocument(context.documentText, context.sourcePath);
	const lineText = splitLines(context.documentText)[context.line] ?? '';
	const receiver = receiverAt(analysis.maskedText, (analysis.lineStarts[context.line] ?? 0) + context.wordStart);
	const request: DefinitionRequest = { context, analysis, owner: analysis.owners[context.line], receiver };

	const serviceClass = serviceBeanToClassName(context.word);
	if (serviceClass && !lineText.match(new RegExp(`\\bdef\\s+${escapeRegExp(context.word)}\\s*\\(`))) {
		const serviceTargets = artifactTargets(context, serviceClass);
		if (serviceTargets.length > 0) {
			return serviceTargets;
		}
	}

	const methodTargets = resolveMethodTargets(request, lineText);
	if (methodTargets.length > 0) {
		return methodTargets;
	}

	const fieldTargets = resolveFieldTargets(request);
	if (fieldTargets.length > 0) {
		return fieldTargets;
	}

	const getterTargets = resolveGetterTargets(request);
	if (getterTargets.length > 0) {
		return getterTargets;
	}

	const constantTargets = resolveConstantTargets(request);
	if (constantTargets.length > 0) {
		return constantTargets;
	}

	if (/^[A-Z]/.test(context.word)) {
		const artifactTargetsResult = artifactTargets(context, context.word);
		if (artifactTargetsResult.length > 0) {
			return artifactTargetsResult;
		}
		return resolveTypeFromClasspath(context, context.word);
	}

	return [];
}

interface DefinitionRequest {
	context: DefinitionContext;
	analysis: DocumentAnalysis;
	owner: ParsedClassSymbol | undefined;
	receiver: ReceiverAt;
}

function resolveMethodTargets(request: DefinitionRequest, lineText: string): DefinitionTarget[] {
	const { context, receiver } = request;
	const methodName = context.word;
	if (!methodName || methodName === 'def' || /^[A-Z]/.test(methodName)) {
		return [];
	}

	if (lineText.match(new RegExp(`^\\s*def\\s+${escapeRegExp(methodName)}\\s*\\(`))) {
		return [];
	}

	if (receiver.kind === 'opaque') {
		return [];
	}
	if (receiver.kind === 'none' && serviceBeanToClassName(methodName)) {
		return [];
	}

	if (receiver.kind === 'name' && receiver.name === 'super') {
		return firstFound(ownerParents(request), parent => findMethodInArtifactHierarchy(context, parent, methodName));
	}
	if (receiver.kind === 'name' && receiver.name !== 'this') {
		return firstFound(receiverTypeCandidates(request, receiver), className => findMethodInArtifactHierarchy(context, className, methodName));
	}

	const local = ownMethods(request, methodName).map(method => ({
		uri: context.sourcePath,
		line: method.line,
		column: method.column,
		label: methodName
	}));
	if (local.length > 0) {
		return local;
	}
	return firstFound(ownerParents(request), parent => findMethodInArtifactHierarchy(context, parent, methodName));
}

function ownMethods(request: DefinitionRequest, methodName: string): ParsedMethod[] {
	const named = request.analysis.symbols.methods.filter(method => method.name === methodName);
	const owner = request.owner;
	if (!owner || named.length <= 1) {
		return named;
	}
	const enclosing = request.analysis.symbols.classes
		.filter(cls => cls.fqn === owner.fqn || owner.fqn.startsWith(`${cls.fqn}.`))
		.sort((a, b) => b.fqn.length - a.fqn.length);
	for (const cls of enclosing) {
		const declared = named.filter(method => method.classFqn === cls.fqn);
		if (declared.length > 0) {
			return declared;
		}
	}
	return named;
}

function ownerParents(request: DefinitionRequest): string[] {
	const owner = request.owner;
	return owner ? [...owner.extendsTypes, ...owner.implementsTypes].map(simpleNameFromFqn) : [];
}

function receiverTypeCandidates(request: DefinitionRequest, receiver: { name: string; chain?: string[] }): string[] {
	const chainType = receiver.chain ? resolveReceiverChainType(request, receiver.chain) : undefined;
	const declaredType = receiver.chain ? undefined : request.analysis.resolveType(receiver.name, request.context.line);
	return [...new Set([
		...(chainType ? [chainType] : []),
		...(declaredType ? [simpleNameFromFqn(declaredType)] : []),
		...candidateClassNamesForReceiver(receiver.name)
	])];
}

function firstFound(candidates: string[], find: (candidate: string) => DefinitionTarget[]): DefinitionTarget[] {
	for (const candidate of candidates) {
		const found = find(candidate);
		if (found.length > 0) {
			return found;
		}
	}
	return [];
}

function findMethodInArtifactHierarchy(
	context: DefinitionContext,
	className: string,
	methodName: string
): DefinitionTarget[] {
	const locations = findMethodInClassHierarchy(
		filePath => readFileSafe(filePath),
		name => findClassEntries(context, name),
		className,
		methodName,
		new Set(),
		0,
		context.documentText
	);
	return locations.map(loc => ({
		uri: loc.filePath,
		line: loc.line,
		column: loc.column,
		label: `${className}.${methodName}`
	}));
}

function resolveFieldTargets(request: DefinitionRequest): DefinitionTarget[] {
	const { context, receiver } = request;
	const fieldName = context.word;
	if (!fieldName || /^[A-Z]/.test(fieldName) || receiver.kind !== 'name') {
		return [];
	}
	if (receiver.name === 'this') {
		return resolveOwnFieldTarget(request, fieldName);
	}
	return firstFound(receiverTypeCandidates(request, receiver), className => findFieldInArtifactHierarchy(context, className, fieldName));
}

function resolveGetterTargets(request: DefinitionRequest): DefinitionTarget[] {
	const { context, receiver } = request;
	const propertyName = context.word;
	const lineText = request.analysis.maskedLines[context.line] ?? '';
	if (!propertyName || /^[A-Z]/.test(propertyName) || receiver.kind !== 'name' || receiver.name === 'super'
		|| !isPropertyRead(lineText, context.wordStart + propertyName.length)) {
		return [];
	}
	const getters = getterNamesForProperty(propertyName);
	if (receiver.name === 'this') {
		const own = request.analysis.symbols.methods.filter(method => getters.includes(method.name)
			&& (!request.owner || method.classFqn === request.owner.fqn)
			&& declaresNoParameters(request.analysis.maskedLines[method.line] ?? '', method.name));
		if (own.length > 0) {
			return own.map(method => ({ uri: context.sourcePath, line: method.line, column: method.column, label: method.name }));
		}
		return firstFound(ownerParents(request), parent => findGetterInArtifactHierarchy(context, parent, getters));
	}
	return firstFound(resolvedReceiverTypes(request, receiver), className => findGetterInArtifactHierarchy(context, className, getters));
}

function resolvedReceiverTypes(request: DefinitionRequest, receiver: { name: string; chain?: string[] }): string[] {
	if (receiver.chain) {
		const chainType = resolveReceiverChainType(request, receiver.chain);
		return chainType ? [chainType] : [];
	}
	if (/^[A-Z]/.test(receiver.name)) {
		return [receiver.name];
	}
	const declaredType = request.analysis.resolveType(receiver.name, request.context.line);
	return declaredType ? [simpleNameFromFqn(declaredType)] : [];
}

function findGetterInArtifactHierarchy(context: DefinitionContext, className: string, getters: string[]): DefinitionTarget[] {
	for (const getter of getters) {
		const found = findMethodInArtifactHierarchy(context, className, getter).filter(target => {
			const declarationLine = target.uri.includes('jar:') ? undefined : splitLines(readFileSafe(target.uri) ?? '')[target.line];
			return declarationLine === undefined || declaresNoParameters(declarationLine, getter);
		});
		if (found.length > 0) {
			return found;
		}
	}
	return [];
}

function resolveOwnFieldTarget(request: DefinitionRequest, fieldName: string): DefinitionTarget[] {
	const { context, owner } = request;
	const ownField = request.analysis.symbols.fields.find(
		field => field.classMember && field.name === fieldName && (!owner || field.classFqn === owner.fqn)
	);
	if (ownField) {
		return [{ uri: context.sourcePath, line: ownField.line, column: ownField.column, label: fieldName }];
	}
	return firstFound(ownerParents(request), parent => findFieldInArtifactHierarchy(context, parent, fieldName));
}

function findFieldInArtifactHierarchy(
	context: DefinitionContext,
	className: string,
	fieldName: string
): DefinitionTarget[] {
	const locations = findFieldInClassHierarchy(
		filePath => readFileSafe(filePath),
		name => findClassEntries(context, name),
		className,
		fieldName,
		context.documentText
	);
	return locations.map(loc => ({
		uri: loc.filePath,
		line: loc.line,
		column: loc.column,
		label: `${className}.${fieldName}`
	}));
}

function findClassEntries(context: DefinitionContext, className: string): Array<{ filePath: string; packageName?: string }> {
	const artifactEntries = context.artifactIndex.findAllByClassName(className);
	if (artifactEntries.length > 0) {
		return artifactEntries;
	}
	const declared = [...new Set(context.classStore.lookup(className)
		.filter(type => type.source === 'workspace' && type.sourcePath)
		.map(type => type.sourcePath as string))];
	if (declared.length > 0) {
		return declared.map(filePath => ({ filePath }));
	}
	if (!context.workspaceRoot) {
		return [];
	}
	const fqn = resolveFqnForSimpleName(context, className);
	const sourcePath = fqn ? findSourceForTypeFqn(fqn, context.workspaceRoot) : undefined;
	return sourcePath ? [{ filePath: sourcePath }] : [];
}

function findSourceForTypeFqn(fqn: string, workspaceRoot: string): string | undefined {
	for (let candidate = fqn; /\.[A-Z]\w*$/.test(candidate); candidate = packageNameFromFqn(candidate)) {
		const sourcePath = findGrailsSourceForFqn(candidate, workspaceRoot);
		if (sourcePath) {
			return sourcePath;
		}
	}
	return undefined;
}

function resolveTypeFromClasspath(context: DefinitionContext, simpleName: string): DefinitionTarget[] {
	const importMap = buildImportMap(context.documentText);
	const importedFqn = importMap.bySimpleName.get(simpleName);

	if (importedFqn) {
		const fromWorkspace = workspaceTargetForFqn(context, importedFqn, simpleName);
		if (fromWorkspace) {
			return [fromWorkspace];
		}
	}

	const fqns = resolveSimpleTypeName(simpleName, importMap, context.classStore);
	const ranked = rankTypeMatches(
		fqns.map(fqn => context.classStore.lookupByFqn(fqn)).filter((type): type is NonNullable<typeof type> => Boolean(type)),
		importMap.packageName
	);
	const fromStore = ranked.map(type => typeToTarget(type, context)).filter((target): target is DefinitionTarget => Boolean(target));
	if (fromStore.length > 0) {
		return fromStore;
	}

	if (importedFqn && context.classpathJars?.length) {
		const fromJars = resolveImportedTypeInJars(importedFqn, context.classpathJars);
		if (fromJars) {
			return [fromJars];
		}
	}

	return [];
}

function workspaceTargetForFqn(
	context: DefinitionContext,
	fqn: string,
	simpleName: string
): DefinitionTarget | undefined {
	if (!context.workspaceRoot) {
		return undefined;
	}
	const sourcePath = findGrailsSourceForFqn(fqn, context.workspaceRoot);
	if (!sourcePath) {
		return undefined;
	}
	const pos = resolveDeclarationPosition(sourcePath, simpleName);
	return { uri: sourcePath, line: pos.line, column: pos.column, label: fqn };
}

function resolveImportedTypeInJars(fqn: string, jars: string[]): DefinitionTarget | undefined {
	for (const jar of jars) {
		const resolved = resolveJarTypeDefinition(jar, fqn);
		if (resolved) {
			return { uri: resolved.uri, line: 0, column: 0, label: fqn };
		}
	}
	return undefined;
}

function artifactTargets(context: DefinitionContext, className: string): DefinitionTarget[] {
	const entries = context.artifactIndex.findAllByClassName(className);
	if (entries.length > 0) {
		return entries.map(entry => {
			const pos = resolveDeclarationPosition(entry.filePath, className);
			return {
				uri: entry.filePath,
				line: pos.line,
				column: pos.column,
				label: className
			};
		});
	}
	if (!context.workspaceRoot) {
		return [];
	}
	const fqn = resolveFqnForSimpleName(context, className);
	if (!fqn) {
		return [];
	}
	const sourcePath = findGrailsSourceForFqn(fqn, context.workspaceRoot);
	if (!sourcePath) {
		return [];
	}
	const pos = resolveDeclarationPosition(sourcePath, className);
	return [{
		uri: sourcePath,
		line: pos.line,
		column: pos.column,
		label: fqn
	}];
}

function resolveFqnForSimpleName(context: DefinitionContext, className: string): string | undefined {
	return resolveTypeName(className, parsePackageName(context.documentText), parseImports(context.documentText));
}

function typeToTarget(
	type: {
		fqn: string;
		source: 'workspace' | 'jar';
		sourcePath?: string;
		declarationLine?: number;
		declarationColumn?: number;
	},
	context: DefinitionContext
): DefinitionTarget | undefined {
	if (type.source === 'workspace' && type.sourcePath) {
		return {
			uri: type.sourcePath,
			line: type.declarationLine ?? 0,
			column: type.declarationColumn ?? 0,
			label: type.fqn
		};
	}
	if (type.source === 'jar') {
		const simpleName = simpleNameFromFqn(type.fqn);
		const fromWorkspace = workspaceTargetForFqn(context, type.fqn, simpleName);
		if (fromWorkspace) {
			return fromWorkspace;
		}
		if (type.sourcePath) {
			const resolved = resolveJarTypeDefinition(type.sourcePath, type.fqn);
			if (resolved) {
				return {
					uri: resolved.uri,
					line: 0,
					column: 0,
					label: type.fqn
				};
			}
		}
		if (context.classpathJars?.length) {
			return resolveImportedTypeInJars(type.fqn, context.classpathJars);
		}
	}
	return undefined;
}

function resolveConstantTargets(request: DefinitionRequest): DefinitionTarget[] {
	const { context, analysis, receiver } = request;
	const name = context.word;
	const own = analysis.symbols;
	const declared = own.enumConstants.find(constant =>
		constant.line === context.line && constant.column === context.wordStart && constant.name === name);
	if (declared) {
		return [enumConstantDeclarationTarget(context, own, declared)];
	}

	if (receiver.kind === 'none') {
		if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
			return [];
		}
		const ownConstant = own.enumConstants.find(constant => constant.name === name);
		if (ownConstant) {
			return [{ uri: context.sourcePath, line: ownConstant.line, column: ownConstant.column, label: name }];
		}
		const ownField = own.fields.find(field => field.classMember && field.name === name);
		if (ownField) {
			return [{ uri: context.sourcePath, line: ownField.line, column: ownField.column, label: name }];
		}
		return firstFound(staticImportOwners(context.documentText, name), owner => constantInType(context, owner, name));
	}

	if (receiver.kind !== 'name' || !/^[A-Z]/.test(receiver.name)) {
		return [];
	}
	const found = constantInType(context, receiver.name, name);
	return found.length > 0 ? found : findFieldInArtifactHierarchy(context, receiver.name, name);
}

function constantInType(context: DefinitionContext, typeName: string, name: string): DefinitionTarget[] {
	const entries = preferReferencedEntries(findClassEntries(context, typeName), typeName, readFileSafe, context.documentText);
	for (const entry of entries) {
		const content = readFileSafe(entry.filePath);
		const constant = content
			? analyzeDocument(content, entry.filePath).symbols.enumConstants.find(candidate =>
				candidate.name === name && simpleNameFromFqn(candidate.enumFqn) === typeName)
			: undefined;
		if (constant) {
			return [{ uri: entry.filePath, line: constant.line, column: constant.column, label: `${typeName}.${name}` }];
		}
	}
	return [];
}

function staticImportOwners(documentText: string, name: string): string[] {
	return parseImportEntries(documentText)
		.filter(entry => entry.isStatic && (entry.wildcard || simpleNameFromFqn(entry.fqn) === name))
		.map(entry => simpleNameFromFqn(entry.wildcard ? entry.fqn : packageNameFromFqn(entry.fqn)));
}

function enumConstantDeclarationTarget(
	context: DefinitionContext,
	symbols: ParsedDocumentSymbols,
	constant: ParsedEnumConstant
): DefinitionTarget {
	const constructors = symbols.constructors.filter(candidate => candidate.classFqn === constant.enumFqn);
	const constructor = constructors.find(candidate => candidate.parameterCount === constant.argumentCount) ?? constructors[0];
	if (constructor) {
		return { uri: context.sourcePath, line: constructor.line, column: constructor.column, label: simpleNameFromFqn(constant.enumFqn) };
	}
	const enumClass = symbols.classes.find(cls => cls.fqn === constant.enumFqn);
	return { uri: context.sourcePath, line: enumClass?.line ?? 0, column: enumClass?.column ?? 0, label: simpleNameFromFqn(constant.enumFqn) };
}

function resolveReceiverChainType(request: DefinitionRequest, chain: string[]): string | undefined {
	const { context } = request;
	const rootType = resolveChainRootType(context.documentText, context.line, chain[0], context.sourcePath);
	let typeName = rootType ? simpleNameFromFqn(rootType) : undefined;
	for (const segment of chain.slice(1)) {
		if (!typeName) {
			return undefined;
		}
		const member = findFieldInClassHierarchy(readFileSafe, name => findClassEntries(context, name), typeName, segment, context.documentText)[0];
		typeName = member ? member.typeName : /^[A-Z]/.test(segment) ? segment : undefined;
	}
	return typeName;
}

function readFileSafe(filePath: string): string | undefined {
	try {
		return fs.readFileSync(filePath, 'utf8');
	} catch {
		return undefined;
	}
}
