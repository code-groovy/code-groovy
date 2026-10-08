export const GRAILS_IMPLICIT_GETTERS: Record<string, string> = {
	params: 'getParams()',
	request: 'getRequest()',
	response: 'getResponse()',
	session: 'getSession()',
	flash: 'getFlash()',
	servletContext: 'getServletContext()',
	grailsApplication: 'getGrailsApplication()',
	actionName: 'getActionName()',
	controllerName: 'getControllerName()',
	controllerNamespace: 'getControllerNamespace()',
	webRequest: 'getWebRequest()',
	out: 'getOut()'
};

export const GRAILS_WEB_REQUEST_TYPES = [
	'org.grails.web.servlet.mvc.GrailsWebRequest',
	'grails.web.servlet.mvc.GrailsWebRequest',
	'org.codehaus.groovy.grails.web.servlet.mvc.GrailsWebRequest'
];

export const PARAMS_EVAL_FALLBACKS = [
	'this.getProperty("params")',
	'((groovy.lang.GroovyObject)this).getProperty("params")',
	...GRAILS_WEB_REQUEST_TYPES.map(typeName => `${typeName}.lookup().getParams()`)
];

const MAP_LIKE = new Set(['params', 'flash']);
const SESSION_LIKE = new Set(['session']);

const GROOVY_KEYWORDS = new Set([
	'abstract', 'as', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class',
	'const', 'continue', 'def', 'default', 'do', 'double', 'else', 'enum', 'extends', 'false',
	'final', 'finally', 'float', 'for', 'goto', 'if', 'implements', 'import', 'in', 'instanceof',
	'int', 'interface', 'long', 'native', 'new', 'null', 'package', 'private', 'protected',
	'public', 'return', 'short', 'static', 'strictfp', 'super', 'switch', 'synchronized',
	'this', 'throw', 'throws', 'transient', 'true', 'try', 'void', 'volatile', 'while',
	'with', 'trait', 'var'
]);

type RewriteKind = 'value' | 'params' | 'flash' | 'session' | 'bean';

export interface EvaluatableSpan {
	expression: string;
	start: number;
	end: number;
}

export interface InlineValueSpec {
	line: number;
	start: number;
	end: number;
	name: string;
	kind: 'lookup' | 'grails';
	evaluate: string;
}

export function isGrailsImplicit(name: string): boolean {
	return Object.prototype.hasOwnProperty.call(GRAILS_IMPLICIT_GETTERS, name);
}

export function javaBeanGetter(name: string): string {
	return `get${name.charAt(0).toUpperCase()}${name.slice(1)}()`;
}

export function rewriteGroovyEvaluate(expression: string): string {
	const expr = expression.trim();
	if (!expr) {
		return expr;
	}

	let i = skipSpace(expr, 0);
	const root = readIdentifier(expr, i);
	if (!root) {
		return expr;
	}

	i = root.end;
	let out: string;
	let kind: RewriteKind;
	if (root.name === 'this') {
		out = 'this';
		kind = 'bean';
	} else if (isGrailsImplicit(root.name)) {
		out = GRAILS_IMPLICIT_GETTERS[root.name];
		kind = kindOfImplicit(root.name);
	} else {
		out = root.name;
		kind = 'bean';
	}

	while (i < expr.length) {
		i = skipSpace(expr, i);
		if (i >= expr.length) {
			break;
		}

		if (expr[i] === '.') {
			i = skipSpace(expr, i + 1);
			const prop = readIdentifier(expr, i);
			if (!prop) {
				return out + expr.slice(i - 1);
			}
			i = skipSpace(expr, prop.end);
			if (expr[i] === '(') {
				return out + '.' + prop.name + expr.slice(i);
			}
			const rewritten = rewriteProperty(out, kind, prop.name);
			out = rewritten.out;
			kind = rewritten.kind;
			continue;
		}

		if (expr[i] === '[') {
			const bracket = readBracketKey(expr, i);
			if (!bracket) {
				return out + expr.slice(i);
			}
			i = bracket.end;
			out += `.get(${bracket.keySource})`;
			kind = 'value';
			continue;
		}

		return out + expr.slice(i);
	}

	return out;
}

export function javaEvaluateExpressions(expression: string): string[] {
	const trimmed = expression.trim();
	if (!trimmed) {
		return [];
	}
	const rewritten = rewriteGroovyEvaluate(trimmed);
	const parts = splitPropertyPath(trimmed);
	const out: string[] = [];
	const push = (value: string) => {
		if (value && !out.includes(value)) {
			out.push(value);
		}
	};

	if (parts[0] && isGrailsImplicit(parts[0])) {
		const chain = rewritten.replace(/^this\./, '');
		for (const typeName of GRAILS_WEB_REQUEST_TYPES) {
			push(`${typeName}.lookup().${chain}`);
		}
		if (parts[0] === 'params') {
			const suffix = chain.startsWith('getParams()') ? chain.slice('getParams()'.length) : '';
			for (const fallback of PARAMS_EVAL_FALLBACKS) {
				push(fallback + suffix);
			}
		}
	}

	push(`this.${rewritten.replace(/^this\./, '')}`);
	push(rewritten);
	push(trimmed);
	return out;
}

export function findEvaluatableExpression(line: string, character: number): EvaluatableSpan | undefined {
	if (!line.length) {
		return undefined;
	}
	let pos = character;
	if (pos >= line.length) {
		pos = line.length - 1;
	}
	if (pos > 0 && !isIdentChar(line[pos]) && isIdentChar(line[pos - 1])) {
		pos -= 1;
	}
	if (!isIdentChar(line[pos])) {
		return undefined;
	}

	let start = pos;
	let end = pos + 1;
	while (start > 0 && isIdentChar(line[start - 1])) {
		start -= 1;
	}
	while (end < line.length && isIdentChar(line[end])) {
		end += 1;
	}

	while (start > 0) {
		let j = start;
		while (j > 0 && isSpace(line[j - 1])) {
			j -= 1;
		}
		if (line[j - 1] === '.' && (j < 2 || line[j - 2] !== '?')) {
			j -= 1;
			while (j > 0 && isSpace(line[j - 1])) {
				j -= 1;
			}
			if (j > 0 && isIdentChar(line[j - 1])) {
				while (j > 0 && isIdentChar(line[j - 1])) {
					j -= 1;
				}
				start = j;
				continue;
			}
			break;
		}
		if (j >= 2 && line[j - 1] === '.' && line[j - 2] === '?') {
			j -= 2;
			while (j > 0 && isSpace(line[j - 1])) {
				j -= 1;
			}
			if (j > 0 && isIdentChar(line[j - 1])) {
				while (j > 0 && isIdentChar(line[j - 1])) {
					j -= 1;
				}
				start = j;
				continue;
			}
			break;
		}
		if (line[j - 1] === ']') {
			const open = line.lastIndexOf('[', j - 1);
			if (open >= 0 && open < j) {
				start = open;
				continue;
			}
		}
		break;
	}

	const expression = line.slice(start, end).replace(/\s+/g, '');
	if (!expression) {
		return undefined;
	}
	return { expression, start, end };
}

export function collectInlineValueSpecs(
	source: string,
	fromLine = 0,
	toLine?: number,
	stoppedLine?: number
): InlineValueSpec[] {
	const lines = source.split(/\n/);
	const last = stoppedLine !== undefined
		? Math.min(stoppedLine, lines.length - 1)
		: toLine === undefined
			? lines.length - 1
			: Math.min(toLine, lines.length - 1);
	const specs: InlineValueSpec[] = [];
	const seen = new Set<string>();

	for (let line = Math.max(0, fromLine); line <= last; line++) {
		const raw = lines[line];
		const masked = maskNonCode(raw);
		const identRe = /[A-Za-z_][\w$]*/g;
		let match: RegExpExecArray | null;
		while ((match = identRe.exec(masked)) !== null) {
			const name = match[0];
			const start = match.index;
			const end = start + name.length;
			if (GROOVY_KEYWORDS.has(name) || name === 'this') {
				continue;
			}
			if (isPropertyAccessTarget(raw, start) || isMethodCallTarget(raw, end)) {
				continue;
			}
			const key = `${line}:${start}:${name}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			specs.push({
				line,
				start,
				end,
				name,
				kind: 'lookup',
				evaluate: name
			});
		}
	}

	return specs;
}

function isPropertyAccessTarget(line: string, start: number): boolean {
	let j = start;
	while (j > 0 && /\s/.test(line[j - 1])) {
		j -= 1;
	}
	return j > 0 && (line[j - 1] === '.' || (j >= 2 && line[j - 2] === '?' && line[j - 1] === '.'));
}

function isMethodCallTarget(line: string, end: number): boolean {
	let j = end;
	while (j < line.length && /\s/.test(line[j])) {
		j += 1;
	}
	return j < line.length && line[j] === '(';
}

/** Property navigation only — no calls, operators, or assignment (safe for variable-tree resolve). */
export function isPurePropertyPath(expression: string): boolean {
	const expr = expression.trim().replace(/\s+/g, '');
	if (!expr) {
		return false;
	}
	if (/[()]/.test(expr) || /[=+\-*/%&|^!<>,]/.test(expr)) {
		return false;
	}
	return /^[\w.?[\]"']+$/.test(expr);
}

export function isUsefulEvalResult(result: { result?: string; type?: string } | undefined): boolean {
	if (!result || result.result === undefined) {
		return false;
	}
	const value = result.result.trim();
	if (!value) {
		return false;
	}
	return !/^(Evaluation failed|Cannot evaluate|Error evaluating|The expression cannot|not available)/i.test(value);
}

export function isMissingJavaProjectError(message: string | undefined): boolean {
	return !!message && /specify projectName/i.test(message);
}

export interface DebugVariableNode {
	name: string;
	value: string;
	type?: string;
	variablesReference: number;
}

export function splitPropertyPath(expression: string): string[] {
	const expr = expression.trim().replace(/\s+/g, '');
	if (!expr) {
		return [];
	}
	const parts: string[] = [];
	let buf = '';
	for (let i = 0; i < expr.length; i++) {
		const ch = expr[i];
		if (ch === '?' && expr[i + 1] === '.') {
			if (buf) {
				parts.push(normalizePathPart(buf));
				buf = '';
			}
			i += 1;
			continue;
		}
		if (ch === '.') {
			if (buf) {
				parts.push(normalizePathPart(buf));
				buf = '';
			}
			continue;
		}
		if (ch === '[') {
			if (buf) {
				parts.push(normalizePathPart(buf));
				buf = '';
			}
			const close = expr.indexOf(']', i);
			if (close < 0) {
				break;
			}
			parts.push(expr.slice(i + 1, close).replace(/['"]/g, ''));
			i = close;
			continue;
		}
		if (ch === '(') {
			if (buf) {
				parts.push(normalizePathPart(buf));
				buf = '';
			}
			break;
		}
		if (ch === ')') {
			continue;
		}
		buf += ch;
	}
	if (buf) {
		parts.push(normalizePathPart(buf));
	}
	return parts.filter(Boolean);
}

export function findNamedVariable(nodes: DebugVariableNode[], name: string): DebugVariableNode | undefined {
	const getter = `get${name.charAt(0).toUpperCase()}${name.slice(1)}`;
	return nodes.find(node => node.name === name)
		|| nodes.find(node => node.name === getter || node.name === `${getter}()`)
		|| nodes.find(node => node.name.replace(/^\[|\]$/g, '') === name);
}

export async function resolveVariablePath(
	parts: string[],
	roots: DebugVariableNode[],
	loadChildren: (variablesReference: number) => Promise<DebugVariableNode[]>
): Promise<DebugVariableNode | undefined> {
	if (!parts.length) {
		return undefined;
	}

	let current = findNamedVariable(roots, parts[0]);
	if (!current) {
		for (const receiverName of ['this', 'delegate', 'owner', 'this$0']) {
			const receiver = findNamedVariable(roots, receiverName);
			if (!receiver?.variablesReference) {
				continue;
			}
			const children = await loadChildren(receiver.variablesReference);
			current = findNamedVariable(children, parts[0]);
			if (current) {
				break;
			}
		}
	}
	if (!current) {
		return undefined;
	}

	for (const part of parts.slice(1)) {
		if (!current.variablesReference) {
			return undefined;
		}
		const children = await loadChildren(current.variablesReference);
		current = findNamedVariable(children, part);
		if (!current) {
			return undefined;
		}
	}
	return current;
}

export async function collectGrailsImplicitsFromTree(
	roots: DebugVariableNode[],
	loadChildren: (variablesReference: number) => Promise<DebugVariableNode[]>
): Promise<GrailsDebugVariable[]> {
	const extras: GrailsDebugVariable[] = [];
	const seen = new Set<string>();
	for (const receiverName of ['this', 'delegate', 'owner', 'this$0']) {
		const receiver = findNamedVariable(roots, receiverName);
		if (!receiver?.variablesReference) {
			continue;
		}
		const children = await loadChildren(receiver.variablesReference);
		for (const name of Object.keys(GRAILS_IMPLICIT_GETTERS)) {
			if (seen.has(name)) {
				continue;
			}
			const found = findNamedVariable(children, name);
			if (!found) {
				continue;
			}
			seen.add(name);
			extras.push({
				name,
				value: found.value,
				type: found.type,
				variablesReference: found.variablesReference || 0,
				evaluateName: name
			});
		}
	}
	return extras;
}

function normalizePathPart(part: string): string {
	const bare = part.endsWith('()') ? part.slice(0, -2) : part;
	if (/^get[A-Z]/.test(bare) && bare.length > 3) {
		return bare.charAt(3).toLowerCase() + bare.slice(4);
	}
	return bare;
}

export interface GrailsDebugVariable {
	name: string;
	value: string;
	type?: string;
	variablesReference: number;
	evaluateName: string;
}

function rewriteProperty(out: string, kind: RewriteKind, name: string): { out: string; kind: RewriteKind } {
	if (kind === 'params' || kind === 'flash') {
		return { out: `${out}.get("${name}")`, kind: 'value' };
	}
	if (kind === 'session') {
		return { out: `${out}.getAttribute("${name}")`, kind: 'value' };
	}
	if (isGrailsImplicit(name) && (out === 'this' || kind === 'bean')) {
		return { out: `${out}.${GRAILS_IMPLICIT_GETTERS[name]}`, kind: kindOfImplicit(name) };
	}
	return { out: `${out}.${javaBeanGetter(name)}`, kind: 'bean' };
}

function kindOfImplicit(name: string): RewriteKind {
	if (MAP_LIKE.has(name)) {
		return name as 'params' | 'flash';
	}
	if (SESSION_LIKE.has(name)) {
		return 'session';
	}
	return 'bean';
}

function readIdentifier(text: string, index: number): { name: string; end: number } | undefined {
	if (index >= text.length || !isIdentStart(text[index])) {
		return undefined;
	}
	let end = index + 1;
	while (end < text.length && isIdentChar(text[end])) {
		end += 1;
	}
	return { name: text.slice(index, end), end };
}

function readBracketKey(text: string, index: number): { keySource: string; end: number } | undefined {
	if (text[index] !== '[') {
		return undefined;
	}
	const close = text.indexOf(']', index + 1);
	if (close < 0) {
		return undefined;
	}
	const inner = text.slice(index + 1, close).trim();
	if (!inner) {
		return undefined;
	}
	if (/^['"].*['"]$/.test(inner) || /^[A-Za-z_][\w$]*$/.test(inner) || /^-?\d+$/.test(inner)) {
		const keySource = /^[A-Za-z_][\w$]*$/.test(inner) ? `"${inner}"` : inner;
		return { keySource, end: close + 1 };
	}
	return undefined;
}

function maskNonCode(line: string): string {
	const chars = line.split('');
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < chars.length; i++) {
		const ch = chars[i];
		if (inSingle) {
			if (ch === '\\') {
				chars[i] = ' ';
				if (i + 1 < chars.length) {
					chars[i + 1] = ' ';
					i += 1;
				}
				continue;
			}
			if (ch === "'") {
				inSingle = false;
			}
			chars[i] = ' ';
			continue;
		}
		if (inDouble) {
			if (ch === '\\') {
				chars[i] = ' ';
				if (i + 1 < chars.length) {
					chars[i + 1] = ' ';
					i += 1;
				}
				continue;
			}
			if (ch === '"') {
				inDouble = false;
			}
			chars[i] = ' ';
			continue;
		}
		if (ch === '/' && chars[i + 1] === '/') {
			for (let j = i; j < chars.length; j++) {
				chars[j] = ' ';
			}
			break;
		}
		if (ch === "'") {
			inSingle = true;
			chars[i] = ' ';
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			chars[i] = ' ';
		}
	}
	return chars.join('');
}

function skipSpace(text: string, index: number): number {
	while (index < text.length && isSpace(text[index])) {
		index += 1;
	}
	return index;
}

function isSpace(ch: string): boolean {
	return ch === ' ' || ch === '\t';
}

function isIdentStart(ch: string): boolean {
	return /[A-Za-z_]/.test(ch);
}

function isIdentChar(ch: string | undefined): boolean {
	return !!ch && /[A-Za-z0-9_$]/.test(ch);
}
