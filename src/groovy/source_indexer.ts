import { analyzeSource, CallSiteRecord, excludeDeclarationCallSites } from './call_site_extractor';
import { IndexedType } from './class_index_store';
import { parseImports } from './class_parser';
import { GrailsArtifactEntry, indexGroovyFile } from './grails_artifact_index';
import { intern } from './string_pool';
import { constructorDeclarations, ParsedMethod, parseDocumentSymbols } from './symbol_parser';
import { maskNonCode } from './text_scan_logic';
import { HierarchyMember } from './type_hierarchy_store';
import { indexWorkspaceDocument } from './workspace_symbol_index';

export interface IndexedSource {
	types: IndexedType[];
	methods: ParsedMethod[];
	callSites: CallSiteRecord[];
	typeMentions: string[];
	imports: string[];
	fields: HierarchyMember[];
	enumConstants: HierarchyMember[];
	artifactEntry?: GrailsArtifactEntry;
}

export function indexSourceText(text: string, filePath: string): IndexedSource {
	const maskedText = maskNonCode(text);
	const symbols = parseDocumentSymbols(text, filePath, maskedText);
	const indexed = indexWorkspaceDocument(text, filePath, symbols);
	const analysis = analyzeSource(text, filePath, symbols, maskedText);
	const artifactEntry = filePath.endsWith('.groovy') ? indexGroovyFile(filePath, symbols.packageName || undefined) : undefined;
	return {
		types: indexed.types.map(type => ({
			...type,
			simpleName: intern(type.simpleName),
			fqn: intern(type.fqn),
			extendsTypes: type.extendsTypes?.map(intern),
			implementsTypes: type.implementsTypes?.map(intern)
		})),
		methods: indexed.methods.map(method => ({ ...method, name: intern(method.name), classFqn: intern(method.classFqn) })),
		callSites: excludeDeclarationCallSites(analysis.callSites, [...indexed.methods, ...constructorDeclarations(symbols, filePath)]),
		typeMentions: analysis.typeMentions,
		imports: parseImports(text).map(intern),
		fields: symbols.fields
			.filter(field => field.classMember)
			.map(field => ({ classFqn: intern(field.classFqn), name: intern(field.name), typeName: intern(field.typeName) })),
		enumConstants: symbols.enumConstants.map(constant => ({ classFqn: intern(constant.enumFqn), name: intern(constant.name) })),
		artifactEntry: artifactEntry && {
			...artifactEntry,
			className: intern(artifactEntry.className),
			packageName: artifactEntry.packageName === undefined ? undefined : intern(artifactEntry.packageName)
		}
	};
}
