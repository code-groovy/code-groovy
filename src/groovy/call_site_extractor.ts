import { ParsedClassSymbol, ParsedDocumentSymbols, ParsedMethod, parseDocumentSymbols } from './symbol_parser';
import { isGroovyKeyword } from './groovy_keywords';
import { intern } from './string_pool';
import { depthsAtLineStarts, isImportLine, lineStartOffsets, maskNonCode, splitLines } from './text_scan_logic';

export interface CallSiteRecord {
	methodName: string;
	receiverName: string | undefined;
	receiverKind?: 'chain';
	receiverType?: string;
	receiverRootType?: string;
	receiverPath?: string[];
	ownerClass?: string;
	sourcePath: string;
	line: number;
	column: number;
	receiverLine?: number;
	receiverColumn?: number;
}

export interface SourceAnalysis {
	callSites: CallSiteRecord[];
	typeMentions: string[];
}

interface ReceiverDeclaration {
	type: string | undefined;
	line: number;
}

export type ReceiverTypeResolver = (receiverName: string, line: number) => string | undefined;

export type ReceiverBefore = { kind: 'name'; name: string; offset: number } | { kind: 'chain' };

const CALL_SITE_RE = /\b(?:([A-Za-z_]\w*)\s*[?*]?\.\s*)?([A-Za-z_]\w*)\s*([({])/g;
const TYPED_DECLARATION_RE = /\b([A-Z]\w*)(?:<[^()]*?>)?(?:\[\])*\s+([a-z_]\w*)(?=\s*(?:[=,;)]|->|:(?!:)|$)|\s+in\b)/g;
const DEF_DECLARATION_RE =
	/\b(?:def|var)\s+([a-z_]\w*)\s*=\s*(?:new\s+(?:[a-z_]\w*\s*\.\s*)*([A-Z]\w*)|([A-Z]\w*)\s*\.\s*(?:get|read|load|lock|find|findWhere|findBy\w+|findOrCreate\w+|findOrSave\w+)\s*\()?/g;
const CLOSURE_PARAMS_RE = /\{\s*([a-z_]\w*(?:\s*,\s*[a-z_]\w*)*)\s*->/g;
const TYPE_MENTION_RE = /\b[A-Z]\w*/g;
const CONSTANT_MENTION_RE = /^[A-Z][A-Z0-9]*_[A-Z0-9_]*$/;

const METHOD_POINTER_RE = /\b([A-Za-z_]\w*)\s*\.&\s*([A-Za-z_]\w*)/g;
const QUALIFIED_NEW_BEFORE_RE = /\bnew\s+(?:[A-Za-z_]\w*\s*\.\s*)+$/;
const ANNOTATION_BEFORE_RE = /(?<![.\w])@\s*(?:[A-Za-z_]\w*\s*\.\s*)*$/;

export function analyzeSource(
	text: string,
	sourcePath: string,
	symbols?: ParsedDocumentSymbols,
	maskedText = maskNonCode(text)
): SourceAnalysis {
	const parsed = symbols ?? parseDocumentSymbols(text, sourcePath, maskedText);
	const lines = splitLines(maskedText);
	const originalLines = splitLines(text);
	const lineStarts = lineStartOffsets(maskedText);
	const owners = ownerClassByLine(parsed.classes, lines.length);
	const resolveType = createReceiverTypeResolver(lines, maskedText, parsed, owners);
	const callSites: CallSiteRecord[] = [];
	const typeMentions = new Set<string>();

	for (let lineNo = 0; lineNo < lines.length; lineNo++) {
		const line = lines[lineNo];
		if (!isImportLine(originalLines[lineNo] ?? '') && !/^\s*package\s/.test(line)) {
			for (const mention of line.match(TYPE_MENTION_RE) ?? []) {
				if (!CONSTANT_MENTION_RE.test(mention)) {
					typeMentions.add(intern(mention));
				}
			}
		}
		if (line.includes('.&')) {
			collectMethodPointers(line, lineNo, sourcePath, owners[lineNo]?.fqn, resolveType, callSites);
		}
		if (!line.includes('(') && !line.includes('{')) {
			continue;
		}
		const ownerClass = owners[lineNo]?.fqn;
		CALL_SITE_RE.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = CALL_SITE_RE.exec(line)) !== null) {
			const [, capturedReceiver, methodName, delimiter] = match;
			const methodStart = line.lastIndexOf(methodName, match.index + match[0].length - 1);
			const previousReceiver = capturedReceiver === undefined ? receiverBefore(maskedText, lineStarts[lineNo] + methodStart) : undefined;
			const opaqueChain = previousReceiver?.kind === 'chain';
			const receiverName = capturedReceiver ?? (previousReceiver?.kind === 'name' ? previousReceiver.name : undefined);
			if (delimiter === '{' && !receiverName && !opaqueChain) {
				continue;
			}
			if (isGroovyKeyword(methodName) || isCalledThroughString(originalLines[lineNo] ?? '', methodName, methodStart + methodName.length, match.index + match[0].length - 1)) {
				continue;
			}
			const before = line.slice(0, capturedReceiver !== undefined ? match.index : methodStart);
			if (ANNOTATION_BEFORE_RE.test(before)) {
				continue;
			}
			if (capturedReceiver !== undefined && QUALIFIED_NEW_BEFORE_RE.test(line.slice(0, methodStart))) {
				callSites.push({
					methodName: intern(methodName),
					receiverName: undefined,
					...(ownerClass ? { ownerClass: intern(ownerClass) } : {}),
					sourcePath,
					line: lineNo,
					column: methodStart
				});
				continue;
			}
			const receiverOffset = lineStarts[lineNo] + match.index;
			const chained = capturedReceiver !== undefined && maskedText[skipWhitespaceBackward(maskedText, receiverOffset - 1)] === '.';
			const chain = chained ? receiverChain(maskedText, receiverOffset, capturedReceiver) : undefined;
			const rootType = chain ? chainRootType(chain[0], lineNo, owners, resolveType) : undefined;
			const receiverType = !chained && receiverName && /^[a-z_]/.test(receiverName) && receiverName !== 'this'
				? resolveType(receiverName, lineNo)
				: undefined;
			const receiverPosition = capturedReceiver !== undefined
				? { line: lineNo, column: match.index }
				: previousReceiver?.kind === 'name' ? positionAt(lineStarts, lineNo, previousReceiver.offset) : undefined;
			callSites.push({
				methodName: intern(methodName),
				receiverName: receiverName === undefined ? undefined : intern(receiverName),
				...(opaqueChain ? { receiverKind: 'chain' as const } : {}),
				...(receiverType ? { receiverType: intern(receiverType) } : {}),
				...(chain && rootType ? { receiverRootType: intern(rootType), receiverPath: chain.slice(1).map(intern) } : {}),
				...(ownerClass ? { ownerClass: intern(ownerClass) } : {}),
				sourcePath,
				line: lineNo,
				column: methodStart,
				...(receiverPosition && receiverPosition.line !== lineNo ? { receiverLine: receiverPosition.line } : {}),
				...(receiverPosition ? { receiverColumn: receiverPosition.column } : {})
			});
		}
	}

	return { callSites, typeMentions: [...typeMentions] };
}

function collectMethodPointers(
	line: string,
	lineNo: number,
	sourcePath: string,
	ownerClass: string | undefined,
	resolveType: ReceiverTypeResolver,
	callSites: CallSiteRecord[]
): void {
	METHOD_POINTER_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = METHOD_POINTER_RE.exec(line)) !== null) {
		const [, receiverName, methodName] = match;
		const receiverType = /^[a-z_]/.test(receiverName) && receiverName !== 'this' ? resolveType(receiverName, lineNo) : undefined;
		callSites.push({
			methodName: intern(methodName),
			receiverName: intern(receiverName),
			...(receiverType ? { receiverType: intern(receiverType) } : {}),
			...(ownerClass ? { ownerClass: intern(ownerClass) } : {}),
			sourcePath,
			line: lineNo,
			column: match.index + match[0].length - methodName.length,
			receiverColumn: match.index
		});
	}
}

function isCalledThroughString(originalLine: string, methodName: string, nameEnd: number, delimiterIndex: number): boolean {
	return /^[A-Z]/.test(methodName) && originalLine.slice(nameEnd, delimiterIndex).trim().length > 0;
}

export interface DocumentAnalysis {
	text: string;
	sourcePath?: string;
	maskedText: string;
	maskedLines: string[];
	lineStarts: number[];
	symbols: ParsedDocumentSymbols;
	owners: Array<ParsedClassSymbol | undefined>;
	resolveType: ReceiverTypeResolver;
}

const ANALYSIS_CACHE_SIZE = 32;
const analysisCache = new Map<string, DocumentAnalysis>();

export function analyzeDocument(text: string, sourcePath?: string): DocumentAnalysis {
	const key = sourcePath ?? '';
	const cached = analysisCache.get(key);
	if (cached && cached.text === text) {
		analysisCache.delete(key);
		analysisCache.set(key, cached);
		return cached;
	}
	const maskedText = maskNonCode(text);
	const symbols = parseDocumentSymbols(text, sourcePath, maskedText);
	const maskedLines = splitLines(maskedText);
	const owners = ownerClassByLine(symbols.classes, maskedLines.length);
	const analysis: DocumentAnalysis = {
		text,
		sourcePath,
		maskedText,
		maskedLines,
		lineStarts: lineStartOffsets(maskedText),
		symbols,
		owners,
		resolveType: createReceiverTypeResolver(maskedLines, maskedText, symbols, owners)
	};
	analysisCache.delete(key);
	analysisCache.set(key, analysis);
	if (analysisCache.size > ANALYSIS_CACHE_SIZE) {
		analysisCache.delete(analysisCache.keys().next().value as string);
	}
	return analysis;
}

export function resolveReceiverType(text: string, line: number, receiverName: string, sourcePath?: string): string | undefined {
	return analyzeDocument(text, sourcePath).resolveType(receiverName, line);
}

export function resolveChainRootType(text: string, line: number, root: string, sourcePath?: string): string | undefined {
	const { owners, resolveType } = analyzeDocument(text, sourcePath);
	return chainRootType(root, line, owners, resolveType);
}

export function excludeDeclarationCallSites(callSites: CallSiteRecord[], methods: ParsedMethod[]): CallSiteRecord[] {
	const declarationKeys = new Set(
		methods
			.filter(method => method.sourcePath !== undefined)
			.map(method => declarationKey(method.sourcePath as string, method.line, method.column, method.name))
	);
	return callSites.filter(callSite => {
		if (callSite.receiverName || callSite.receiverKind) {
			return true;
		}
		return !declarationKeys.has(declarationKey(callSite.sourcePath, callSite.line, callSite.column, callSite.methodName));
	});
}

export function ownerClassByLine(classes: ParsedClassSymbol[], lineCount: number): Array<ParsedClassSymbol | undefined> {
	const owners: Array<ParsedClassSymbol | undefined> = new Array(lineCount);
	const sorted = [...classes].sort((a, b) => a.line - b.line);
	const open: ParsedClassSymbol[] = [];
	let next = 0;
	for (let line = 0; line < lineCount; line++) {
		while (open.length > 0 && open[open.length - 1].endLine < line) {
			open.pop();
		}
		while (next < sorted.length && sorted[next].line === line) {
			open.push(sorted[next++]);
		}
		owners[line] = open[open.length - 1];
	}
	return owners;
}

export function receiverBefore(maskedText: string, offset: number): ReceiverBefore | undefined {
	let i = skipWhitespaceBackward(maskedText, offset - 1);
	if (maskedText[i] !== '.') {
		return undefined;
	}
	i--;
	if (maskedText[i] === '?' || maskedText[i] === '*') {
		i--;
	}
	i = skipWhitespaceBackward(maskedText, i);
	const end = i + 1;
	while (i >= 0 && /\w/.test(maskedText[i])) {
		i--;
	}
	const identifier = maskedText.slice(i + 1, end);
	if (!/^[A-Za-z_]\w*$/.test(identifier) || maskedText[skipWhitespaceBackward(maskedText, i)] === '.') {
		return { kind: 'chain' };
	}
	return { kind: 'name', name: identifier, offset: i + 1 };
}

export type ReceiverAt =
	| { kind: 'none' }
	| { kind: 'opaque' }
	| { kind: 'name'; name: string; chain?: string[] };

export function receiverAt(maskedText: string, offset: number): ReceiverAt {
	let i = skipWhitespaceBackward(maskedText, offset - 1);
	if (maskedText[i] !== '.') {
		return { kind: 'none' };
	}
	i--;
	if (maskedText[i] === '?' || maskedText[i] === '*') {
		i--;
	}
	i = skipWhitespaceBackward(maskedText, i);
	const end = i + 1;
	while (i >= 0 && /\w/.test(maskedText[i])) {
		i--;
	}
	const name = maskedText.slice(i + 1, end);
	if (!/^[A-Za-z_]\w*$/.test(name)) {
		return { kind: 'opaque' };
	}
	const before = skipWhitespaceBackward(maskedText, i);
	if (maskedText[before] !== '.') {
		return { kind: 'name', name };
	}
	const chain = receiverChain(maskedText, i + 1, name);
	return chain ? { kind: 'name', name, chain } : { kind: 'opaque' };
}

function positionAt(lineStarts: number[], fromLine: number, offset: number): { line: number; column: number } {
	let line = fromLine;
	while (line > 0 && lineStarts[line] > offset) {
		line--;
	}
	return { line, column: offset - lineStarts[line] };
}

export function receiverChain(maskedText: string, receiverOffset: number, receiver: string): string[] | undefined {
	const segments = [receiver];
	let i = skipWhitespaceBackward(maskedText, receiverOffset - 1);
	while (maskedText[i] === '.') {
		i--;
		if (maskedText[i] === '?' || maskedText[i] === '*') {
			i--;
		}
		i = skipWhitespaceBackward(maskedText, i);
		const end = i + 1;
		while (i >= 0 && /\w/.test(maskedText[i])) {
			i--;
		}
		const identifier = maskedText.slice(i + 1, end);
		if (!/^[A-Za-z_]\w*$/.test(identifier)) {
			return undefined;
		}
		segments.unshift(identifier);
		i = skipWhitespaceBackward(maskedText, i);
	}
	return segments.length > 1 ? segments : undefined;
}

function chainRootType(
	root: string,
	line: number,
	owners: Array<ParsedClassSymbol | undefined>,
	resolveType: ReceiverTypeResolver
): string | undefined {
	if (root === 'this') {
		return owners[line]?.simpleName;
	}
	if (/^[A-Z]/.test(root)) {
		return root;
	}
	return resolveType(root, line);
}

function skipWhitespaceBackward(text: string, index: number): number {
	let i = index;
	while (i >= 0 && /\s/.test(text[i])) {
		i--;
	}
	return i;
}

function createReceiverTypeResolver(
	maskedLines: string[],
	maskedText: string,
	symbols: ParsedDocumentSymbols,
	owners: Array<ParsedClassSymbol | undefined>
): ReceiverTypeResolver {
	const declarations = collectReceiverDeclarations(maskedLines);
	const { braces, parens } = depthsAtLineStarts(maskedText);
	const scopeStarts = scopeStartByLine(maskedLines, braces, parens, owners);
	const classFields = new Map<string, string>();
	for (const field of symbols.fields) {
		if (field.classMember) {
			classFields.set(`${field.classFqn}#${field.name}`, field.typeName);
		}
	}

	return (receiverName, line) => {
		const scopeStart = scopeStarts[line] ?? 0;
		const visible = (declarations.get(receiverName) ?? []).filter(declaration => declaration.line >= scopeStart && declaration.line <= line);
		if (visible.length > 0) {
			return visible[visible.length - 1].type;
		}
		const owner = owners[line];
		return owner ? classFields.get(`${owner.fqn}#${receiverName}`) : undefined;
	};
}

function scopeStartByLine(
	maskedLines: string[],
	depths: number[],
	parenDepths: number[],
	owners: Array<ParsedClassSymbol | undefined>
): number[] {
	const starts: number[] = new Array(owners.length);
	let lastMemberLevelLine = 0;
	for (let line = 0; line < owners.length; line++) {
		const owner = owners[line];
		const memberDepth = owner?.bodyDepth ?? 0;
		const continuesDeclaration = (parenDepths[line] ?? 0) > 0 || /^\s*\{/.test(maskedLines[line] ?? '');
		if ((depths[line] ?? 0) <= memberDepth && !continuesDeclaration) {
			lastMemberLevelLine = line;
			starts[line] = memberDepth > 0 ? line : 0;
		} else {
			starts[line] = lastMemberLevelLine;
		}
	}
	return starts;
}

function collectReceiverDeclarations(maskedLines: string[]): Map<string, ReceiverDeclaration[]> {
	const byName = new Map<string, ReceiverDeclaration[]>();
	for (let lineNo = 0; lineNo < maskedLines.length; lineNo++) {
		const line = maskedLines[lineNo];
		const found: Array<{ index: number; name: string; type: string | undefined }> = [];
		if (/[A-Z]/.test(line)) {
			collectMatches(TYPED_DECLARATION_RE, line, match => {
				found.push({ index: match.index, name: match[2], type: match[1] });
				const end = match.index + match[0].length;
				for (const extra of /^\s*=(?!=)/.test(line.slice(end)) ? followingDeclarators(line, end) : []) {
					found.push({ index: extra.index, name: extra.name, type: match[1] });
				}
			});
		}
		if (line.includes('def') || line.includes('var')) {
			collectMatches(DEF_DECLARATION_RE, line, match => found.push({ index: match.index, name: match[1], type: match[2] ?? match[3] }));
		}
		if (line.includes('->')) {
			collectMatches(CLOSURE_PARAMS_RE, line, match => {
				for (const name of match[1].split(',')) {
					found.push({ index: match.index, name: name.trim(), type: undefined });
				}
			});
		}
		found.sort((a, b) => a.index - b.index);
		for (const declaration of found) {
			const list = byName.get(declaration.name) ?? [];
			list.push({ type: declaration.type, line: lineNo });
			byName.set(declaration.name, list);
		}
	}
	return byName;
}

function followingDeclarators(line: string, from: number): Array<{ index: number; name: string }> {
	const declarators: Array<{ index: number; name: string }> = [];
	let depth = 0;
	for (let i = from; i < line.length; i++) {
		const ch = line[i];
		if (ch === '(' || ch === '[' || ch === '{') {
			depth++;
		} else if (ch === ')' || ch === ']' || ch === '}') {
			if (depth === 0) {
				break;
			}
			depth--;
		} else if (ch === ';' && depth === 0) {
			break;
		} else if (ch === ',' && depth === 0) {
			const next = /^,\s*([a-z_]\w*)\s*(?==(?!=)|,|;|$)/.exec(line.slice(i));
			if (!next) {
				break;
			}
			declarators.push({ index: i, name: next[1] });
		}
	}
	return declarators;
}

function collectMatches(re: RegExp, line: string, onMatch: (match: RegExpExecArray) => void): void {
	re.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = re.exec(line)) !== null) {
		onMatch(match);
		if (match[0].length === 0) {
			re.lastIndex++;
		}
	}
}

function declarationKey(sourcePath: string, line: number, column: number, name: string): string {
	return `${sourcePath}::${line}::${column}::${name}`;
}
