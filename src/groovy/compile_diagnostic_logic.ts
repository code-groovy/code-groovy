import * as fs from 'fs';
import * as path from 'path';

export const DIAGNOSTIC_PREFIX = 'CODE_GROOVY_DIAG:';

export interface CompilerDiagnostic {
	message: string;
	severity: 'error' | 'warning';
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
}

export interface CompilerDaemonResponse {
	id?: string;
	error?: string;
	diagnostics?: CompilerDiagnostic[];
}

export interface DiagnosticSpan {
	startLine: number;
	startCharacter: number;
	endLine: number;
	endCharacter: number;
}

const OUTPUT_SEGMENTS = [
	['build', 'classes', 'groovy', 'main'],
	['build', 'classes', 'java', 'main'],
	['build', 'classes', 'main'],
	['target', 'classes'],
	['build', 'classes', 'groovy', 'test'],
	['build', 'classes', 'java', 'test'],
	['build', 'classes', 'test'],
	['target', 'test-classes']
];

const SKIP_CHILD_DIRS = new Set(['build', 'target', 'node_modules', 'out', 'bin', '.git', '.gradle']);

export function isGroovyRuntimeJar(entry: string): boolean {
	const base = path.basename(entry).toLowerCase();
	if (base.includes('-sources') || base.includes('-javadoc')) {
		return false;
	}
	return /^groovy(?:-all)?(?:-\d.*)?\.jar$/.test(base);
}

export function classpathHasGroovy(entries: string[]): boolean {
	return entries.some(isGroovyRuntimeJar);
}

export function orderCompileClasspath(outputDirs: string[], jars: string[]): string[] {
	const groovy: string[] = [];
	const rest: string[] = [];
	for (const jar of jars) {
		if (isGroovyRuntimeJar(jar)) {
			groovy.push(jar);
		} else {
			rest.push(jar);
		}
	}
	return unique([...outputDirs, ...groovy, ...rest]);
}

export function findCompileOutputDirs(workspaceRoot: string): string[] {
	const roots = [workspaceRoot];
	let children: fs.Dirent[] = [];
	try {
		children = fs.readdirSync(workspaceRoot, { withFileTypes: true });
	} catch {
		children = [];
	}
	for (const child of children) {
		if (!child.isDirectory() || child.name.startsWith('.') || SKIP_CHILD_DIRS.has(child.name)) {
			continue;
		}
		roots.push(path.join(workspaceRoot, child.name));
	}

	const found: string[] = [];
	for (const root of roots) {
		for (const segments of OUTPUT_SEGMENTS) {
			const dir = path.join(root, ...segments);
			try {
				if (fs.statSync(dir).isDirectory()) {
					found.push(dir);
				}
			} catch {
				// output dir is absent until the project is built
			}
		}
	}
	return found;
}

export function buildCompileClasspath(workspaceRoot: string, jars: string[]): string[] {
	const existing = jars.filter(jar => {
		try {
			return fs.existsSync(jar);
		} catch {
			return false;
		}
	});
	return orderCompileClasspath(findCompileOutputDirs(workspaceRoot), existing);
}

export function javaCommandFromEnv(env: NodeJS.ProcessEnv, exists: (filePath: string) => boolean): string {
	const home = env.JAVA_HOME;
	if (home) {
		const executable = process.platform === 'win32' ? 'java.exe' : 'java';
		const candidate = path.join(home, 'bin', executable);
		if (exists(candidate)) {
			return candidate;
		}
	}
	return 'java';
}

export function parseDaemonMessage(line: string): CompilerDaemonResponse | undefined {
	const marker = line.indexOf(DIAGNOSTIC_PREFIX);
	if (marker < 0) {
		return undefined;
	}
	let payload: unknown;
	try {
		payload = JSON.parse(line.slice(marker + DIAGNOSTIC_PREFIX.length));
	} catch {
		return undefined;
	}
	if (!payload || typeof payload !== 'object') {
		return undefined;
	}
	const record = payload as { id?: unknown; error?: unknown; diagnostics?: unknown };
	const response: CompilerDaemonResponse = {};
	if (typeof record.id === 'string') {
		response.id = record.id;
	}
	if (typeof record.error === 'string') {
		response.error = record.error;
	}
	if (Array.isArray(record.diagnostics)) {
		response.diagnostics = record.diagnostics.map(readDiagnostic).filter((item): item is CompilerDiagnostic => !!item);
	}
	return response;
}

const INLINE_ERROR_LIMIT = 200;

/**
 * The compiler's column is often just the token. Underline the whole line so the
 * statement reads as the problem, not a slice of it.
 */
export function compilerDiagnosticSpan(
	diagnostic: CompilerDiagnostic,
	lineCount: number,
	lineLength: (zeroBasedLine: number) => number
): DiagnosticSpan {
	const lastLine = Math.max(0, lineCount - 1);
	const startLine = clamp(diagnostic.line > 0 ? diagnostic.line - 1 : 0, 0, lastLine);
	let endLine = diagnostic.endLine > 0 ? diagnostic.endLine - 1 : startLine;
	endLine = clamp(endLine, startLine, lastLine);
	return {
		startLine,
		startCharacter: 0,
		endLine,
		endCharacter: lineLength(endLine)
	};
}

/** One overlay label per line. The text is not written into the file. */
export function inlineErrorLabels(diagnostics: CompilerDiagnostic[]): Array<{ line: number; text: string; warning: boolean }> {
	const byLine = new Map<number, { messages: string[]; warning: boolean }>();
	for (const diagnostic of diagnostics) {
		const line = diagnostic.line > 0 ? diagnostic.line : 1;
		const text = inlineErrorText(diagnostic.message);
		const existing = byLine.get(line) ?? { messages: [], warning: true };
		if (!existing.messages.includes(text)) {
			existing.messages.push(text);
		}
		if (diagnostic.severity !== 'warning') {
			existing.warning = false;
		}
		byLine.set(line, existing);
	}
	return [...byLine].map(([line, group]) => ({
		line,
		text: group.messages.join(' · '),
		warning: group.warning
	}));
}

export function inlineErrorText(message: string): string {
	const single = message.replace(/\s+/g, ' ').trim();
	if (single.length <= INLINE_ERROR_LIMIT) {
		return single;
	}
	return `${single.slice(0, INLINE_ERROR_LIMIT - 1)}…`;
}

function readDiagnostic(value: unknown): CompilerDiagnostic | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const record = value as Partial<CompilerDiagnostic>;
	if (typeof record.message !== 'string' || !record.message.trim()) {
		return undefined;
	}
	return {
		message: record.message.trim(),
		severity: record.severity === 'warning' ? 'warning' : 'error',
		line: numberOrZero(record.line),
		column: numberOrZero(record.column),
		endLine: numberOrZero(record.endLine),
		endColumn: numberOrZero(record.endColumn)
	};
}

function numberOrZero(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

function unique(entries: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const entry of entries) {
		if (!entry || seen.has(entry)) {
			continue;
		}
		seen.add(entry);
		result.push(entry);
	}
	return result;
}
