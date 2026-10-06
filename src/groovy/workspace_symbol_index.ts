import { IndexedType } from './class_index_store';
import { ParsedDocumentSymbols, parseDocumentSymbols } from './symbol_parser';

export function indexWorkspaceDocument(text: string, sourcePath: string, symbols?: ParsedDocumentSymbols): {
	types: IndexedType[];
	methods: ReturnType<typeof parseDocumentSymbols>['methods'];
} {
	const parsed = symbols ?? parseDocumentSymbols(text, sourcePath);
	const types: IndexedType[] = parsed.classes.map(cls => ({
		simpleName: cls.simpleName,
		fqn: cls.fqn,
		source: 'workspace' as const,
		sourcePath,
		declarationLine: cls.line,
		declarationColumn: cls.column,
		extendsTypes: cls.extendsTypes,
		implementsTypes: cls.implementsTypes
	}));
	return { types, methods: parsed.methods };
}
