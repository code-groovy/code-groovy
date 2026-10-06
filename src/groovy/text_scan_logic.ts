export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isImportLine(line: string): boolean {
	return /^\s*import\s/.test(line);
}

type MaskFrame =
	| { kind: 'string'; delimiter: string; interpolates: boolean; multiline: boolean }
	| { kind: 'interpolation'; depth: number };

interface CommentRange {
	start: number;
	end: number;
}

export function maskNonCode(text: string): string {
	return scanNonCode(text);
}

function scanNonCode(text: string, comments?: CommentRange[]): string {
	const pieces: string[] = [];
	let copiedUntil = 0;
	let blankStart = 0;
	let blankEnd = 0;
	const flush = () => {
		if (blankEnd > blankStart) {
			pieces.push(text.slice(copiedUntil, blankStart), text.slice(blankStart, blankEnd).replace(/[^\r\n]/g, ' '));
			copiedUntil = blankEnd;
		}
		blankStart = blankEnd = copiedUntil;
	};
	const stack: MaskFrame[] = [];
	const blank = (from: number, to: number) => {
		const start = Math.max(from, blankEnd, copiedUntil);
		const end = Math.min(to, text.length);
		if (start >= end) {
			return;
		}
		if (start !== blankEnd || blankEnd === blankStart) {
			flush();
			blankStart = start;
		}
		blankEnd = end;
	};

	let i = 0;
	while (i < text.length) {
		const top = stack[stack.length - 1];
		if (top?.kind === 'string') {
			const stop = nextIndex(stringStopRe(top), text, i);
			if (stop > i) {
				blank(i, stop);
				i = stop;
				continue;
			}
			if (top.delimiter === DOLLAR_SLASHY_END ? text[i] === '$' && (text[i + 1] === '$' || text[i + 1] === '/') : text[i] === '\\') {
				blank(i, i + 2);
				i += 2;
				continue;
			}
			if (text.startsWith(top.delimiter, i)) {
				blank(i, i + top.delimiter.length);
				i += top.delimiter.length;
				stack.pop();
				continue;
			}
			if (top.interpolates && text[i] === '$' && text[i + 1] === '{') {
				blank(i, i + 2);
				i += 2;
				stack.push({ kind: 'interpolation', depth: 0 });
				continue;
			}
			if (!top.multiline && text[i] === '\n') {
				stack.pop();
				i++;
				continue;
			}
			blank(i, i + 1);
			i++;
			continue;
		}

		const special = nextIndex(top ? INTERPOLATION_STOP_RE : CODE_STOP_RE, text, i);
		if (special >= text.length) {
			break;
		}
		i = special;
		const ch = text[i];
		const next = text[i + 1];
		if (ch === '/' && next === '/') {
			const lineEnd = text.indexOf('\n', i);
			const stop = lineEnd === -1 ? text.length : lineEnd;
			comments?.push({ start: i, end: stop + 1 });
			blank(i, stop);
			i = stop;
			continue;
		}
		if (ch === '/' && next === '*') {
			const close = text.indexOf('*/', i + 2);
			const stop = close === -1 ? text.length : close + 2;
			comments?.push({ start: i, end: close === -1 ? text.length + 1 : stop });
			blank(i, stop);
			i = stop;
			continue;
		}
		if (ch === '"' || ch === "'") {
			const delimiter = text.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch;
			blank(i, i + delimiter.length);
			stack.push({ kind: 'string', delimiter, interpolates: ch === '"', multiline: delimiter.length === 3 });
			i += delimiter.length;
			continue;
		}
		if (ch === '$' && next === '/') {
			blank(i, i + 2);
			stack.push({ kind: 'string', delimiter: DOLLAR_SLASHY_END, interpolates: true, multiline: true });
			i += 2;
			continue;
		}
		if (ch === '/' && opensSlashyString(text, i)) {
			blank(i, i + 1);
			stack.push({ kind: 'string', delimiter: '/', interpolates: true, multiline: true });
			i++;
			continue;
		}
		if (top?.kind === 'interpolation') {
			if (ch === '{') {
				top.depth++;
			} else if (ch === '}') {
				if (top.depth === 0) {
					blank(i, i + 1);
					stack.pop();
					i++;
					continue;
				}
				top.depth--;
			}
		}
		i++;
	}
	flush();
	pieces.push(text.slice(copiedUntil));
	return pieces.join('');
}

const CODE_STOP_RE = /[/"'$]/g;
const INTERPOLATION_STOP_RE = /[/"'{}$]/g;
const DOUBLE_QUOTED_STOP_RE = /[\\"$\n]/g;
const SINGLE_QUOTED_STOP_RE = /[\\'\n]/g;
const SLASHY_STOP_RE = /[\\/$]/g;
const DOLLAR_SLASHY_STOP_RE = /[/$]/g;
const DOLLAR_SLASHY_END = '/$';
const SLASHY_OPENER_BEFORE = new Set(['~', '=', '(', ',', '[', ':', '{', ';', '!', '&', '|', '?', '*', '%', '<', '>', '^']);
const SLASHY_KEYWORDS_BEFORE = new Set(['return', 'in', 'case', 'assert', 'else', 'yield']);

function stringStopRe(frame: { delimiter: string; interpolates: boolean }): RegExp {
	if (frame.delimiter === '/') {
		return SLASHY_STOP_RE;
	}
	if (frame.delimiter === DOLLAR_SLASHY_END) {
		return DOLLAR_SLASHY_STOP_RE;
	}
	return frame.interpolates ? DOUBLE_QUOTED_STOP_RE : SINGLE_QUOTED_STOP_RE;
}

function opensSlashyString(text: string, index: number): boolean {
	const next = text[index + 1];
	if (next === undefined || next === '/' || next === '*' || next === '=' || /\s/.test(next)) {
		return false;
	}
	let i = index - 1;
	while (i >= 0 && /\s/.test(text[i])) {
		i--;
	}
	if (i < 0) {
		return true;
	}
	const before = text[i];
	if (/[\w$]/.test(before)) {
		let start = i;
		while (start > 0 && /[\w$]/.test(text[start - 1])) {
			start--;
		}
		return SLASHY_KEYWORDS_BEFORE.has(text.slice(start, i + 1));
	}
	if (before === '+' || before === '-') {
		return text[i - 1] !== before;
	}
	return SLASHY_OPENER_BEFORE.has(before);
}

function nextIndex(re: RegExp, text: string, from: number): number {
	re.lastIndex = from;
	const match = re.exec(text);
	return match ? match.index : text.length;
}

export interface WordMatch {
	line: number;
	column: number;
}

export function findWordMatches(text: string, word: string, receiverFieldName?: string): WordMatch[] {
	if (!word || !text.includes(word)) {
		return [];
	}
	const pattern = receiverFieldName
		? `\\b${escapeRegExp(receiverFieldName)}\\s*[?*]?\\.\\s*(${escapeRegExp(word)})\\b`
		: `\\b(${escapeRegExp(word)})\\b`;
	const lineRegex = new RegExp(pattern, 'gd');
	const originalLines = splitLines(text);
	const maskedLines = splitLines(maskNonCode(text));
	const matches: WordMatch[] = [];
	for (let lineNo = 0; lineNo < maskedLines.length; lineNo++) {
		const line = maskedLines[lineNo];
		if (!line.includes(word) || isImportLine(originalLines[lineNo] ?? '')) {
			continue;
		}
		lineRegex.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = lineRegex.exec(line)) !== null) {
			const indices = (match as RegExpExecArray & { indices: Array<[number, number]> }).indices;
			matches.push({ line: lineNo, column: indices[1][0] });
		}
	}
	return matches;
}

export function splitLines(text: string): string[] {
	return text.split(LINE_BREAK_RE);
}

export function lineStartOffsets(text: string): number[] {
	const starts = [0];
	for (let i = 0; i < text.length; i++) {
		if (isLineBreakEnd(text, i)) {
			starts.push(i + 1);
		}
	}
	return starts;
}

export interface LineDepths {
	braces: number[];
	parens: number[];
}

let lastDepths: { text: string; depths: LineDepths } | undefined;

export function depthsAtLineStarts(maskedText: string): LineDepths {
	if (lastDepths?.text === maskedText) {
		return lastDepths.depths;
	}
	const braces = [0];
	const parens = [0];
	let braceDepth = 0;
	let parenDepth = 0;
	for (let i = 0; i < maskedText.length; i++) {
		const ch = maskedText[i];
		if (ch === '{') {
			braceDepth++;
		} else if (ch === '}') {
			braceDepth = Math.max(0, braceDepth - 1);
		} else if (ch === '(') {
			parenDepth++;
		} else if (ch === ')') {
			parenDepth = Math.max(0, parenDepth - 1);
		} else if (isLineBreakEnd(maskedText, i)) {
			braces.push(braceDepth);
			parens.push(parenDepth);
		}
	}
	const depths = { braces, parens };
	lastDepths = { text: maskedText, depths };
	return depths;
}

export function closingBraceLine(maskedText: string, fromOffset: number, fromLine: number): number | undefined {
	let line = fromLine;
	let depth = 0;
	for (let i = fromOffset; i < maskedText.length; i++) {
		const ch = maskedText[i];
		if (isLineBreakEnd(maskedText, i)) {
			line++;
		} else if (ch === '{') {
			depth++;
		} else if (ch === '}' && depth > 0) {
			depth--;
			if (depth === 0) {
				return line;
			}
		}
	}
	return undefined;
}

export type TopLevelScan = { parts: string[]; terminator: number; blockEnd: number };

export function scanTopLevel(text: string, terminatorChar = ';'): TopLevelScan {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	let terminator = -1;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === '(' || ch === '{' || ch === '[') {
			depth++;
		} else if (ch === ')' || ch === '}' || ch === ']') {
			if (depth === 0 && ch === '}') {
				parts.push(text.slice(start, i));
				return { parts, terminator, blockEnd: i };
			}
			depth = Math.max(0, depth - 1);
		} else if (depth === 0 && ch === ',') {
			parts.push(text.slice(start, i));
			start = i + 1;
		} else if (depth === 0 && ch === terminatorChar && terminator < 0) {
			terminator = i;
			parts.push(text.slice(start, i));
			return { parts, terminator, blockEnd: -1 };
		}
	}
	parts.push(text.slice(start));
	return { parts, terminator, blockEnd: -1 };
}

const LINE_BREAK_RE = /\r\n|\r|\n/;

function isLineBreakEnd(text: string, index: number): boolean {
	const ch = text[index];
	return ch === '\n' || (ch === '\r' && text[index + 1] !== '\n');
}

export function isInsideComment(text: string, offset: number): boolean {
	const comments: CommentRange[] = [];
	scanNonCode(text, comments);
	return comments.some(range => offset >= range.start && offset < range.end);
}

export function isInsideDocLink(line: string, character: number): boolean {
	const referenceRe = /\{@link(?:plain)?\s+[^}]*\}|@(?:see|throws|exception)\s+[\w.#$]+/g;
	let match: RegExpExecArray | null;
	while ((match = referenceRe.exec(line)) !== null) {
		if (character >= match.index && character < match.index + match[0].length) {
			return true;
		}
	}
	return false;
}
