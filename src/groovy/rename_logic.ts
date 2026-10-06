import { isGroovyKeyword } from './groovy_keywords';
import { escapeRegExp, maskNonCode } from './text_scan_logic';

export interface TextRange {
	start: number;
	end: number;
}

export interface PrepareRenameResult {
	range: TextRange;
	placeholder: string;
}

const IDENTIFIER_RE = /^[A-Za-z_]\w*$/;

export function isValidIdentifier(name: string): boolean {
	return IDENTIFIER_RE.test(name);
}

export function wordRangeAt(documentText: string, offset: number): TextRange | undefined {
	if (offset < 0 || offset > documentText.length) {
		return undefined;
	}
	let start = offset;
	let end = offset;
	while (start > 0 && /[A-Za-z0-9_]/.test(documentText[start - 1])) {
		start -= 1;
	}
	while (end < documentText.length && /[A-Za-z0-9_]/.test(documentText[end])) {
		end += 1;
	}
	if (start === end) {
		return undefined;
	}
	const word = documentText.slice(start, end);
	if (!isValidIdentifier(word) || /^[0-9]/.test(word)) {
		return undefined;
	}
	return { start, end };
}

export function prepareLocalRename(documentText: string, offset: number): PrepareRenameResult | undefined {
	const range = wordRangeAt(documentText, offset);
	if (!range) {
		return undefined;
	}
	const placeholder = documentText.slice(range.start, range.end);
	if (isGroovyKeyword(placeholder)) {
		return undefined;
	}
	return { range, placeholder };
}

/**
 * Collect same-file rename edits for an identifier, skipping comments and string literals.
 * MVP for F2: does not cross files and does not attempt semantic scope analysis.
 */
export function collectLocalRenameEdits(
	documentText: string,
	oldName: string,
	newName: string
): TextRange[] {
	if (!isValidIdentifier(oldName) || !isValidIdentifier(newName) || oldName === newName) {
		return [];
	}
	if (isGroovyKeyword(newName)) {
		return [];
	}

	const edits: TextRange[] = [];
	const masked = maskNonCode(documentText);
	const wordRe = new RegExp(`(?<![\\w$])${escapeRegExp(oldName)}(?![\\w$])`, 'g');
	let match: RegExpExecArray | null;
	while ((match = wordRe.exec(masked)) !== null) {
		edits.push({ start: match.index, end: match.index + oldName.length });
	}
	return edits;
}

export function applyLocalRename(documentText: string, oldName: string, newName: string): string {
	const edits = collectLocalRenameEdits(documentText, oldName, newName);
	if (edits.length === 0) {
		return documentText;
	}
	let result = '';
	let cursor = 0;
	for (const edit of edits) {
		result += documentText.slice(cursor, edit.start);
		result += newName;
		cursor = edit.end;
	}
	result += documentText.slice(cursor);
	return result;
}
