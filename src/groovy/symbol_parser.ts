import { simpleNameFromFqn } from './class_index_store';
import { isGroovyKeyword } from './groovy_keywords';
import { classNameForBean } from './service_bean';
import { parsePackageName } from './class_parser';
import { closingBraceLine, depthsAtLineStarts, escapeRegExp, lineStartOffsets, maskNonCode, scanTopLevel, splitLines } from './text_scan_logic';

export interface ParsedMethod {
	name: string;
	line: number;
	column: number;
	classFqn: string;
	sourcePath?: string;
}

export interface ParsedField {
	name: string;
	typeName: string;
	line: number;
	column: number;
	classFqn: string;
	classMember: boolean;
}

export interface ParsedClassSymbol {
	simpleName: string;
	fqn: string;
	packageName: string;
	kind: 'class' | 'interface' | 'trait' | 'enum';
	line: number;
	column: number;
	endLine: number;
	bodyDepth: number;
	extendsTypes: string[];
	implementsTypes: string[];
	sourcePath?: string;
}

export interface ParsedEnumConstant {
	name: string;
	line: number;
	column: number;
	enumFqn: string;
	argumentCount?: number;
}

export interface ParsedConstructor {
	classFqn: string;
	line: number;
	column: number;
	parameterCount?: number;
}

export interface ParsedDocumentSymbols {
	packageName: string;
	classes: ParsedClassSymbol[];
	methods: ParsedMethod[];
	fields: ParsedField[];
	enumConstants: ParsedEnumConstant[];
	constructors: ParsedConstructor[];
}

const IDENTIFIER = '[A-Za-z_\\u00C0-\\uFFFF][\\w\\u00C0-\\uFFFF]*';
const ANNOTATIONS = '(?:@[\\w.]+(?:\\([^)]*\\))?\\s+)*';
const TYPE_MODIFIERS = '(?:(?:public|protected|private|static|final|abstract|sealed|non-sealed)\\s+)*';
const CLASS_START_RE = new RegExp(`^\\s*${ANNOTATIONS}${TYPE_MODIFIERS}(?:class|interface|trait|enum)\\s+${IDENTIFIER}`);
const CLASS_LINE_RE = new RegExp(
	`^\\s*${ANNOTATIONS}${TYPE_MODIFIERS}(class|interface|trait|enum)\\s+(${IDENTIFIER})(?:\\s*<[^{]*?>)?(?:\\s+extends\\s+([^{]+?))?(?:\\s+implements\\s+([^{]+?))?\\s*(?:\\{.*)?$`,
	'd'
);
const MAX_HEADER_LINES = 6;
const MAX_DECLARATION_LINE_LENGTH = 2000;
const MODIFIER = '(?:public|protected|private|static|final|abstract|synchronized|default)';
const TYPE_PARAMETERS = '(?:<[^()]*?>\\s+)?';
const RETURN_TYPE = '(?:def|(?:void|boolean|byte|char|short|int|long|float|double|(?:[a-z_]\\w*\\.)*[A-Z][\\w.]*(?:<[^()]*>)?)(?:\\[\\])*)';
const METHOD_LINE_RE = new RegExp(
	`^\\s*${ANNOTATIONS}(?:(?:${MODIFIER}\\s+)*${TYPE_PARAMETERS}${RETURN_TYPE}|(?:${MODIFIER}\\s+)*${MODIFIER})\\s+(${IDENTIFIER})\\s*\\(`,
	'd'
);
const FIELD_LINE_RE =
	/^\s*(?:(?:public|protected|private|static|final)\s+)*([A-Z][A-Za-z0-9_]*)\s+([a-zA-Z_]\w*)\s*(?:=|;|$)/;
const SERVICE_INJECT_RE = /^\s*def\s+([a-z][A-Za-z0-9_]*Service)\s*(?:=|;|$)/;
const TYPED_FIELD_RE =
	/^\s*(?:(?:public|protected|private|static|final)\s+)*([A-Z][A-Za-z0-9_]*)\s+([a-zA-Z_]\w*)\s*=/;

function splitTypeList(raw: string | undefined): string[] {
	if (!raw) {
		return [];
	}
	let withoutGenerics = raw;
	while (/<[^<>]*>/.test(withoutGenerics)) {
		withoutGenerics = withoutGenerics.replace(/<[^<>]*>/g, '');
	}
	return withoutGenerics.split(',').map(part => part.trim()).filter(part => /^[A-Za-z_][\w.]*$/.test(part));
}

export function parseDocumentSymbols(text: string, sourcePath?: string, maskedText = maskNonCode(text)): ParsedDocumentSymbols {
	const packageName = parsePackageName(text);
	const lines = splitLines(maskedText);
	const originalLines = splitLines(text);
	const lineStarts = lineStartOffsets(maskedText);
	const classes: ParsedClassSymbol[] = [];
	const methods: ParsedMethod[] = [];
	const fields: ParsedField[] = [];
	const { braces: depths, parens: parenDepths } = depthsAtLineStarts(maskedText);
	const isClassMemberLine = (line: number) =>
		openClasses.length > 0 && parenDepths[line] === 0 && depths[line] === openClasses[openClasses.length - 1].bodyDepth;
	const scriptClassFqn = packageName ? `${packageName}.${inferScriptClassName(sourcePath)}` : inferScriptClassName(sourcePath);
	const openClasses: ParsedClassSymbol[] = [];
	const enumConstants: ParsedEnumConstant[] = [];
	const constructors: ParsedConstructor[] = [];
	const constructorPatterns = new Map<ParsedClassSymbol, RegExp>();
	let enumReadingConstants: ParsedClassSymbol | undefined;
	let currentClassFqn = scriptClassFqn;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineStart = lineStarts[i];
		while (openClasses.length > 0 && openClasses[openClasses.length - 1].endLine < i) {
			openClasses.pop();
			currentClassFqn = openClasses[openClasses.length - 1]?.fqn ?? scriptClassFqn;
		}
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('//') || line.length > MAX_DECLARATION_LINE_LENGTH) {
			continue;
		}

		const classMatch = CLASS_START_RE.test(line) ? matchClassHeader(lines, i) : undefined;
		if (classMatch) {
			const kind = classMatch[1] as ParsedClassSymbol['kind'];
			const simpleName = classMatch[2];
			const enclosing = openClasses[openClasses.length - 1];
			const fqn = enclosing ? `${enclosing.fqn}.${simpleName}` : packageName ? `${packageName}.${simpleName}` : simpleName;
			const column = matchIndices(classMatch)[2][0];
			const symbol: ParsedClassSymbol = {
				simpleName,
				fqn,
				packageName,
				kind,
				line: i,
				column: column >= 0 ? column : 0,
				endLine: closingBraceLine(maskedText, lineStart + Math.max(column, 0), i) ?? lines.length - 1,
				bodyDepth: (depths[i] ?? 0) + 1,
				extendsTypes: splitTypeList(classMatch[3]),
				implementsTypes: splitTypeList(classMatch[4]),
				sourcePath
			};
			classes.push(symbol);
			openClasses.push(symbol);
			constructorPatterns.set(symbol, constructorPattern(simpleName));
			currentClassFqn = fqn;
			const bodyStart = line.indexOf('{', column);
			let membersFrom = bodyStart >= 0 ? bodyStart + 1 : -1;
			if (kind === 'enum') {
				enumReadingConstants = symbol;
				const constantsEnd = bodyStart >= 0 ? readEnumConstants(line, originalLines[i] ?? line, bodyStart + 1, i, symbol, enumConstants) : undefined;
				if (constantsEnd !== undefined) {
					enumReadingConstants = undefined;
				}
				membersFrom = constantsEnd ?? -1;
			}
			if (membersFrom >= 0) {
				const member = METHOD_LINE_RE.exec(line.slice(membersFrom));
				if (member && !isGroovyKeyword(member[1])) {
					methods.push({ name: member[1], line: i, column: membersFrom + matchIndices(member)[1][0], classFqn: fqn, sourcePath });
				}
			}
			continue;
		}

		const owner = openClasses[openClasses.length - 1];
		const ownerConstructorPattern = owner ? constructorPatterns.get(owner) : undefined;
		let constructorColumn: number | undefined;
		if (owner && ownerConstructorPattern && depths[i] === owner.bodyDepth && parenDepths[i] === 0) {
			constructorColumn = constructorColumnFor(line, ownerConstructorPattern);
			if (constructorColumn !== undefined) {
				constructors.push({
					classFqn: owner.fqn,
					line: i,
					column: constructorColumn,
					parameterCount: argumentCountAt(line, originalLines[i] ?? line, constructorColumn + owner.simpleName.length)
				});
			}
		}

		if (enumReadingConstants) {
			if (owner !== enumReadingConstants) {
				enumReadingConstants = undefined;
			} else if (depths[i] === owner.bodyDepth && parenDepths[i] === 0) {
				if (METHOD_LINE_RE.test(line) || FIELD_LINE_RE.test(line) || TYPED_FIELD_RE.test(line) || SERVICE_INJECT_RE.test(line)
					|| constructorColumn !== undefined) {
					enumReadingConstants = undefined;
				} else {
					if (readEnumConstants(line, originalLines[i] ?? line, 0, i, owner, enumConstants) !== undefined) {
						enumReadingConstants = undefined;
					}
					continue;
				}
			}
		}

		if (constructorColumn !== undefined) {
			continue;
		}

		const methodMatch = METHOD_LINE_RE.exec(line);
		if (methodMatch) {
			const name = methodMatch[1];
			if (!isGroovyKeyword(name)) {
				methods.push({
					name,
					line: i,
					column: matchIndices(methodMatch)[1][0],
					classFqn: currentClassFqn,
					sourcePath
				});
			}
			continue;
		}

		const serviceMatch = line.match(SERVICE_INJECT_RE);
		if (serviceMatch) {
			const serviceName = serviceMatch[1];
			const typeName = classNameForBean(serviceName);
			const column = line.indexOf(serviceName);
			fields.push({
				name: serviceName,
				typeName,
				line: i,
				column: column >= 0 ? column : 0,
				classFqn: currentClassFqn,
				classMember: isClassMemberLine(i)
			});
			continue;
		}

		const typedField = line.match(TYPED_FIELD_RE) ?? line.match(FIELD_LINE_RE);
		if (typedField) {
			const typeName = typedField[1];
			const name = typedField[2];
			const column = line.indexOf(name, line.indexOf(typeName) + typeName.length);
			fields.push({
				typeName,
				name,
				line: i,
				column: column >= 0 ? column : 0,
				classFqn: currentClassFqn,
				classMember: isClassMemberLine(i)
			});
		}
	}

	if (classes.length === 0 && (methods.length > 0 || fields.length > 0)) {
		const scriptName = inferScriptClassName(sourcePath);
		const fqn = packageName ? `${packageName}.${scriptName}` : scriptName;
		classes.push({
			simpleName: scriptName,
			fqn,
			packageName,
			kind: 'class',
			line: 0,
			column: 0,
			endLine: lines.length - 1,
			bodyDepth: 0,
			extendsTypes: [],
			implementsTypes: [],
			sourcePath
		});
	}

	return { packageName, classes, methods, fields, enumConstants, constructors };
}

export function constructorDeclarations(symbols: ParsedDocumentSymbols, sourcePath: string): ParsedMethod[] {
	return symbols.constructors.map(constructor => ({
		name: simpleNameFromFqn(constructor.classFqn),
		line: constructor.line,
		column: constructor.column,
		classFqn: constructor.classFqn,
		sourcePath
	}));
}


function readEnumConstants(
	line: string,
	originalLine: string,
	from: number,
	lineNo: number,
	owner: ParsedClassSymbol,
	constants: ParsedEnumConstant[]
): number | undefined {
	const scan = scanTopLevel(line.slice(from));
	let offset = 0;
	for (const part of scan.parts) {
		const match = part.match(/^\s*(?:@[\w.]+(?:\([^)]*\))?\s+)*([A-Za-z_]\w*)\s*(?=\(|\{|\}|$)/);
		if (match) {
			const column = from + offset + part.indexOf(match[1]);
			constants.push({
				name: match[1],
				line: lineNo,
				column,
				enumFqn: owner.fqn,
				argumentCount: argumentCountAt(line, originalLine, column + match[1].length)
			});
		}
		offset += part.length + 1;
	}
	if (scan.terminator >= 0) {
		return from + scan.terminator + 1;
	}
	return scan.blockEnd >= 0 ? -1 : undefined;
}

function matchClassHeader(lines: string[], start: number): RegExpExecArray | undefined {
	let header = lines[start];
	for (let next = start + 1; !header.includes('{') && next < lines.length && next <= start + MAX_HEADER_LINES; next++) {
		const continuation = lines[next].trim();
		if (!/^(?:extends|implements|,|\{|[A-Za-z_][\w.]*\s*(?:<|,|\{|$))/.test(continuation)) {
			break;
		}
		header += ' ' + lines[next];
	}
	return CLASS_LINE_RE.exec(header) ?? undefined;
}

function matchIndices(match: RegExpExecArray): Array<[number, number]> {
	return (match as RegExpExecArray & { indices: Array<[number, number]> }).indices;
}

function argumentCountAt(maskedLine: string, originalLine: string, afterName: number): number | undefined {
	const openParen = afterName + (maskedLine.slice(afterName).match(/^\s*/)?.[0].length ?? 0);
	if (maskedLine[openParen] !== '(') {
		return 0;
	}
	let depth = 0;
	for (let i = openParen; i < maskedLine.length; i++) {
		const ch = maskedLine[i];
		if (ch === '(') {
			depth++;
		} else if (ch === ')') {
			depth--;
			if (depth === 0) {
				const inside = originalLine.slice(openParen + 1, i);
				return inside.trim() ? scanTopLevel(maskedLine.slice(openParen + 1, i), '').parts.length : 0;
			}
		}
	}
	return undefined;
}

function constructorPattern(className: string): RegExp {
	return new RegExp(`^(\\s*(?:(?:public|protected|private)\\s+)?)${escapeRegExp(className)}\\s*\\(`);
}

function constructorColumnFor(line: string, pattern: RegExp): number | undefined {
	const match = line.match(pattern);
	return match ? match[1].length : undefined;
}

function inferScriptClassName(sourcePath?: string): string {
	if (!sourcePath) {
		return 'Script';
	}
	const base = sourcePath.replace(/\\/g, '/').split('/').pop() ?? 'Script';
	return base.replace(/\.(groovy|java)$/, '');
}
