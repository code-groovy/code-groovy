import * as fs from 'fs';
import * as path from 'path';
import { DefinitionTarget } from '../groovy/definition_resolver';
import { isTestPath } from '../groovy/grails_artifact_index';
import { findMethodInClassHierarchy } from '../groovy/method_navigation_logic';
import { escapeRegExp, maskNonCode } from '../groovy/text_scan_logic';
import { collectGrailsAppRoots } from './gsp_resource_path_logic';

export type LinkArgName = 'controller' | 'action' | 'view';

export interface LinkArg {
	name: LinkArgName;
	value?: string;
	valueStart: number;
	valueEnd: number;
}

export interface LinkCall {
	callee: string;
	args: LinkArg[];
}

export interface LinkArgHit {
	arg: LinkArg;
	call: LinkCall;
}

export interface ControllerActionContext {
	sourcePath: string;
	workspaceRoot?: string;
	findEntries: (className: string) => Array<{ filePath: string; packageName?: string }>;
}

const LINK_METHODS = new Set([
	'actionSubmit', 'chain', 'createLink', 'form', 'formRemote', 'forward', 'include', 'link', 'paginate',
	'redirect', 'remoteFunction', 'remoteLink', 'sortableColumn', 'submitToRemote', 'uploadForm'
]);
const VIEW_METHODS = new Set(['render', 'respond']);
const CONTROLLER_ONLY_METHODS = new Set(['chain', 'forward', 'redirect']);
const GSP_LINK_TAGS = new Set([...LINK_METHODS].filter(method => !CONTROLLER_ONLY_METHODS.has(method)));
const NAMED_ARG_KEY_RE = /\b(controller|action|view)\s*:/g;
const QUICK_KEY_RE = /\b(?:controller|action|view)\s*[:=]/;
const QUOTED_LITERAL_RE = /^[ \t]*(["'])([^"'$\\\r\n]*)\1(?=[ \t]*(?:[,;)\]}\r\n]|\/[/*]|$))/;
const TAG_ATTR_RE = /(?<=\s)(controller|action)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const TAG_START_RE = /^<([A-Za-z_]\w*):([A-Za-z_]\w*)/;
const NAME_RE = /^[A-Za-z_]\w*$/;
const VIEW_RE = /^[\w./-]+$/;
const MAX_SCAN = 4000;

export function mayContainLinkArg(lineText: string): boolean {
	return QUICK_KEY_RE.test(lineText);
}

export function findGroovyLinkArgAt(text: string, offset: number, masked: string = maskNonCode(text)): LinkArgHit | undefined {
	const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
	const newline = text.indexOf('\n', offset);
	const lineEnd = newline === -1 ? text.length : newline;
	const arg = namedArgsIn(text, masked, lineStart, lineEnd)
		.find(candidate => offset >= candidate.valueStart && offset <= candidate.valueEnd);
	if (!arg) {
		return undefined;
	}
	const call = enclosingCall(text, masked, arg.keyStart);
	if (!call || !acceptsArg(call.callee, arg.name)) {
		return undefined;
	}
	const own = call.args.find(candidate => candidate.valueStart === arg.valueStart);
	return own?.value !== undefined ? { arg: own, call } : undefined;
}

export function findGspTagLinkArgAt(text: string, offset: number): LinkArgHit | undefined {
	const tag = enclosingGspTag(text, offset);
	if (!tag || tag.namespace !== 'g' || !GSP_LINK_TAGS.has(tag.method)) {
		return undefined;
	}
	const args: LinkArg[] = [];
	const tagText = text.slice(tag.start, tag.end);
	TAG_ATTR_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = TAG_ATTR_RE.exec(tagText)) !== null) {
		const raw = match[2] ?? match[3] ?? '';
		const valueStart = tag.start + match.index + match[0].length - raw.length - 1;
		args.push(literalArg(match[1] as LinkArgName, raw, valueStart));
	}
	const arg = args.find(candidate => offset >= candidate.valueStart && offset <= candidate.valueEnd);
	return arg?.value !== undefined ? { arg, call: { callee: tag.method, args } } : undefined;
}

export function resolveControllerActionDefinitions(hit: LinkArgHit, context: ControllerActionContext): DefinitionTarget[] {
	const { arg, call } = hit;
	if (arg.value === undefined) {
		return [];
	}
	if (arg.name === 'view') {
		return viewTargets(arg.value, currentControllerName(context.sourcePath), context);
	}
	if (arg.name === 'controller') {
		return controllerTargets(arg.value, context);
	}
	const controllerArg = call.args.find(candidate => candidate.name === 'controller');
	const controllerName = controllerArg ? controllerArg.value : currentControllerName(context.sourcePath);
	return controllerName ? actionTargets(controllerName, arg.value, context) : [];
}

export function currentControllerName(sourcePath: string): string | undefined {
	const normalized = sourcePath.replace(/\\/g, '/');
	if (/\.gsp$/i.test(normalized)) {
		return /\/grails-app\/views\/([^/]+)\//.exec(normalized)?.[1];
	}
	const match = /^([A-Za-z_]\w*)Controller\.groovy$/.exec(path.basename(normalized));
	return match ? match[1][0].toLowerCase() + match[1].slice(1) : undefined;
}

export function controllerClassName(logicalName: string): string {
	return `${logicalName[0].toUpperCase()}${logicalName.slice(1)}Controller`;
}

interface KeyedLinkArg extends LinkArg {
	keyStart: number;
}

function namedArgsIn(text: string, masked: string, from: number, to: number): KeyedLinkArg[] {
	const args: KeyedLinkArg[] = [];
	NAMED_ARG_KEY_RE.lastIndex = from;
	let match: RegExpExecArray | null;
	while ((match = NAMED_ARG_KEY_RE.exec(masked)) !== null && match.index < to) {
		const afterKey = match.index + match[0].length;
		const literal = QUOTED_LITERAL_RE.exec(text.slice(afterKey, afterKey + 512));
		const name = match[1] as LinkArgName;
		if (literal) {
			args.push({ ...literalArg(name, literal[2], afterKey + literal[0].length - literal[2].length - 1), keyStart: match.index });
		} else {
			args.push({ name, valueStart: afterKey, valueEnd: afterKey, keyStart: match.index });
		}
	}
	return args;
}

function literalArg(name: LinkArgName, raw: string, valueStart: number): LinkArg {
	const valid = name === 'view' ? VIEW_RE.test(raw) : NAME_RE.test(raw);
	return { name, ...(valid ? { value: raw } : {}), valueStart, valueEnd: valueStart + raw.length };
}

function acceptsArg(callee: string, name: LinkArgName): boolean {
	return name === 'view' ? VIEW_METHODS.has(callee) : LINK_METHODS.has(callee);
}

function enclosingCall(text: string, masked: string, keyStart: number): LinkCall | undefined {
	const opener = openerBefore(masked, keyStart);
	if (!opener) {
		return undefined;
	}
	if (opener.paren) {
		const callee = calleeBefore(masked, opener.index);
		if (!callee) {
			return undefined;
		}
		return { callee, args: topLevelArgs(text, masked, opener.index + 1, closingParen(masked, opener.index)) };
	}
	const statement = /^\s*(?:return\s+)?([A-Za-z_][\w.?]*)\s+/.exec(masked.slice(opener.index, keyStart));
	if (!statement) {
		return undefined;
	}
	const argsStart = opener.index + statement[0].length;
	return { callee: lastSegment(statement[1]), args: topLevelArgs(text, masked, argsStart, statementEnd(masked, keyStart)) };
}

function openerBefore(masked: string, from: number): { index: number; paren: boolean } | undefined {
	let depth = 0;
	const limit = Math.max(0, from - MAX_SCAN);
	for (let i = from - 1; i >= limit; i--) {
		const ch = masked[i];
		if (ch === ')' || ch === ']' || ch === '}') {
			depth++;
		} else if (ch === '(' || ch === '[' || ch === '{') {
			if (depth === 0) {
				return ch === '[' ? undefined : { index: ch === '(' ? i : i + 1, paren: ch === '(' };
			}
			depth--;
		} else if (ch === '\n' && depth === 0 && !',([{'.includes(masked[previousNonSpace(masked, i - 1)] ?? '')) {
			return { index: i + 1, paren: false };
		}
	}
	return { index: limit, paren: false };
}

function calleeBefore(masked: string, parenIndex: number): string | undefined {
	const match = /([A-Za-z_][\w.?]*)\s*$/.exec(masked.slice(Math.max(0, parenIndex - 200), parenIndex));
	return match ? lastSegment(match[1]) : undefined;
}

function lastSegment(chain: string): string {
	return chain.split(/[.?]+/).filter(Boolean).pop() ?? chain;
}

function closingParen(masked: string, openIndex: number): number {
	let depth = 0;
	const limit = Math.min(masked.length, openIndex + MAX_SCAN);
	for (let i = openIndex; i < limit; i++) {
		const ch = masked[i];
		if (ch === '(' || ch === '[' || ch === '{') {
			depth++;
		} else if (ch === ')' || ch === ']' || ch === '}') {
			depth--;
			if (depth === 0) {
				return i;
			}
		}
	}
	return limit;
}

function statementEnd(masked: string, from: number): number {
	let depth = 0;
	const limit = Math.min(masked.length, from + MAX_SCAN);
	for (let i = from; i < limit; i++) {
		const ch = masked[i];
		if (ch === '(' || ch === '[' || ch === '{') {
			depth++;
		} else if (ch === ')' || ch === ']' || ch === '}') {
			if (depth === 0) {
				return i;
			}
			depth--;
		} else if (ch === '\n' && depth === 0 && masked[previousNonSpace(masked, i - 1)] !== ',') {
			return i;
		}
	}
	return limit;
}

function topLevelArgs(text: string, masked: string, from: number, to: number): LinkArg[] {
	const args: LinkArg[] = [];
	let depth = 0;
	let cursor = from;
	for (const arg of namedArgsIn(text, masked, from, to)) {
		for (; cursor < arg.keyStart; cursor++) {
			const ch = masked[cursor];
			if (ch === '(' || ch === '[' || ch === '{') {
				depth++;
			} else if (ch === ')' || ch === ']' || ch === '}') {
				depth--;
			}
		}
		if (depth === 0) {
			args.push(withoutKey(arg));
		}
	}
	return args;
}

function withoutKey(arg: KeyedLinkArg): LinkArg {
	return {
		name: arg.name,
		...(arg.value !== undefined ? { value: arg.value } : {}),
		valueStart: arg.valueStart,
		valueEnd: arg.valueEnd
	};
}

function previousNonSpace(text: string, index: number): number {
	let cursor = index;
	while (cursor >= 0 && /\s/.test(text[cursor])) {
		cursor--;
	}
	return cursor;
}

function enclosingGspTag(text: string, offset: number): { namespace: string; method: string; start: number; end: number } | undefined {
	const limit = Math.max(0, offset - MAX_SCAN);
	let start = text.lastIndexOf('<', offset);
	while (start > limit && !/[A-Za-z/!]/.test(text[start + 1] ?? '')) {
		start = text.lastIndexOf('<', start - 1);
	}
	if (start < limit || !/[A-Za-z/!]/.test(text[start + 1] ?? '')) {
		return undefined;
	}
	const tag = TAG_START_RE.exec(text.slice(start, start + 128));
	if (!tag) {
		return undefined;
	}
	const end = unquotedTagEnd(text, start, Math.min(text.length, start + MAX_SCAN));
	if (end <= offset) {
		return undefined;
	}
	return { namespace: tag[1], method: tag[2], start, end };
}

function unquotedTagEnd(text: string, from: number, limit: number): number {
	let quote: string | undefined;
	for (let i = from + 1; i < limit; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === quote) {
				quote = undefined;
			}
		} else if (ch === '"' || ch === '\'') {
			quote = ch;
		} else if (ch === '>') {
			return i;
		}
	}
	return limit;
}

function controllerEntries(logicalName: string, context: ControllerActionContext): Array<{ filePath: string; packageName?: string }> {
	const className = controllerClassName(logicalName);
	const entries = context.findEntries(className)
		.filter(entry => !isTestPath(entry.filePath) && path.basename(entry.filePath, '.groovy') === className);
	const ownRoot = grailsAppRoot(context.sourcePath);
	const sameModule = ownRoot ? entries.filter(entry => grailsAppRoot(entry.filePath) === ownRoot) : [];
	return sameModule.length > 0 ? sameModule : entries;
}

function controllerTargets(logicalName: string, context: ControllerActionContext): DefinitionTarget[] {
	const className = controllerClassName(logicalName);
	return controllerEntries(logicalName, context).map(entry => ({
		uri: entry.filePath,
		...classDeclarationPosition(readFileSafe(entry.filePath), className),
		label: className
	}));
}

function actionTargets(logicalName: string, action: string, context: ControllerActionContext): DefinitionTarget[] {
	const className = controllerClassName(logicalName);
	const targets: DefinitionTarget[] = [];
	for (const entry of controllerEntries(logicalName, context)) {
		const locations = findMethodInClassHierarchy(
			readFileSafe,
			name => name === className ? [entry] : context.findEntries(name),
			className,
			action
		);
		for (const location of locations) {
			if (!targets.some(target => target.uri === location.filePath && target.line === location.line)) {
				targets.push({ uri: location.filePath, line: location.line, column: location.column, label: action });
			}
		}
	}
	return targets;
}

function viewTargets(view: string, controllerName: string | undefined, context: ControllerActionContext): DefinitionTarget[] {
	const relative = view.startsWith('/') ? view.replace(/^\/+/, '') : controllerName ? `${controllerName}/${view}` : undefined;
	if (!relative) {
		return [];
	}
	const file = `${relative.replace(/\.gsp$/i, '')}.gsp`;
	const ownRoot = grailsAppRoot(context.sourcePath);
	const roots = [...new Set([
		...(ownRoot ? [ownRoot] : []),
		...(context.workspaceRoot ? collectGrailsAppRoots(context.workspaceRoot) : [])
	])];
	const found = roots
		.map(root => path.join(root, 'views'))
		.map(views => ({ views, candidate: path.join(views, file) }))
		.find(({ views, candidate }) => candidate.startsWith(views + path.sep) && fs.existsSync(candidate))
		?.candidate;
	return found ? [{ uri: found, line: 0, column: 0, label: view }] : [];
}

function grailsAppRoot(filePath: string): string | undefined {
	const match = /^(.*[\\/]grails-app)[\\/]/.exec(filePath);
	return match ? path.resolve(match[1]) : undefined;
}

function classDeclarationPosition(content: string | undefined, className: string): { line: number; column: number } {
	const pattern = new RegExp(`\\bclass\\s+${escapeRegExp(className)}\\b`);
	const lines = content?.split('\n') ?? [];
	for (let line = 0; line < lines.length; line++) {
		const column = lines[line].search(pattern);
		if (column >= 0) {
			return { line, column };
		}
	}
	return { line: 0, column: 0 };
}

function readFileSafe(filePath: string): string | undefined {
	try {
		return fs.readFileSync(filePath, 'utf8');
	} catch {
		return undefined;
	}
}
