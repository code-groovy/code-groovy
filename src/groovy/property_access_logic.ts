import { analyzeDocument, CallSiteRecord, receiverChain, resolveChainRootType } from './call_site_extractor';
import { escapeRegExp } from './text_scan_logic';

const GETTER_RE = /^(get|is)([A-Z]\w*)$/;
const NOT_A_READ_RE = /^\s*(?:[({]|=(?![=~]))/;

export interface PropertyScan {
	scope: 'properties';
	propertyName: string;
	files: string[];
	accepts: (read: CallSiteRecord) => boolean;
}

export interface PropertyReadLocation {
	sourcePath: string;
	line: number;
	column: number;
	length: number;
}

export function propertyNameForGetter(methodName: string): string | undefined {
	const match = GETTER_RE.exec(methodName);
	if (!match) {
		return undefined;
	}
	const rest = match[2];
	return rest.length > 1 && /[A-Z]/.test(rest[1]) ? rest : rest[0].toLowerCase() + rest.slice(1);
}

export function getterNamesForProperty(propertyName: string): string[] {
	if (!/^[A-Za-z_]\w*$/.test(propertyName)) {
		return [];
	}
	const capitalized = propertyName[0].toUpperCase() + propertyName.slice(1);
	return [`get${capitalized}`, `is${capitalized}`];
}

export function isPropertyRead(lineText: string, wordEnd: number): boolean {
	return !NOT_A_READ_RE.test(lineText.slice(wordEnd));
}

export function declaresNoParameters(lineText: string, methodName: string): boolean {
	return new RegExp(`\\b${escapeRegExp(methodName)}\\s*\\(\\s*\\)`).test(lineText);
}

export function findPropertyReads(text: string, sourcePath: string, propertyName: string): CallSiteRecord[] {
	if (!text.includes(propertyName)) {
		return [];
	}
	const analysis = analyzeDocument(text, sourcePath);
	const { maskedText, maskedLines, lineStarts, owners } = analysis;
	const accessRe = new RegExp(`\\b([A-Za-z_]\\w*)\\s*\\??\\.\\s*(${escapeRegExp(propertyName)})\\b`, 'g');
	const reads: CallSiteRecord[] = [];
	maskedLines.forEach((line, lineNo) => {
		if (!line.includes(propertyName)) {
			return;
		}
		accessRe.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = accessRe.exec(line)) !== null) {
			const receiverName = match[1];
			const column = match.index + match[0].length - propertyName.length;
			if (!isPropertyRead(line, column + propertyName.length)) {
				continue;
			}
			const receiverOffset = (lineStarts[lineNo] ?? 0) + match.index;
			const chained = maskedText[previousNonSpace(maskedText, receiverOffset - 1)] === '.';
			const chain = chained ? receiverChain(maskedText, receiverOffset, receiverName) : undefined;
			const rootType = chain ? resolveChainRootType(text, lineNo, chain[0], sourcePath) : undefined;
			const receiverType = !chained && /^[a-z_]/.test(receiverName) && receiverName !== 'this'
				? analysis.resolveType(receiverName, lineNo)
				: undefined;
			const ownerClass = owners[lineNo]?.fqn;
			reads.push({
				methodName: propertyName,
				receiverName,
				...(chained && !chain ? { receiverKind: 'chain' as const } : {}),
				...(receiverType ? { receiverType } : {}),
				...(chain && rootType ? { receiverRootType: rootType, receiverPath: chain.slice(1) } : {}),
				...(ownerClass ? { ownerClass } : {}),
				sourcePath,
				line: lineNo,
				column
			});
		}
	});
	return reads;
}

export function propertyReadLocations(text: string, sourcePath: string, scan: PropertyScan): PropertyReadLocation[] {
	return findPropertyReads(text, sourcePath, scan.propertyName)
		.filter(scan.accepts)
		.map(read => ({ sourcePath, line: read.line, column: read.column, length: scan.propertyName.length }));
}

function previousNonSpace(text: string, index: number): number {
	let cursor = index;
	while (cursor >= 0 && /\s/.test(text[cursor])) {
		cursor--;
	}
	return cursor;
}
