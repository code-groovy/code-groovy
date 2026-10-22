import * as vscode from 'vscode';
import {
	buildCompileClasspath,
	classpathHasGroovy,
	CompilerDiagnostic,
	compilerDiagnosticSpan,
	inlineErrorLabels
} from './compile_diagnostic_logic';
import { CompilerDaemonClient } from './compiler_daemon';

const DEBOUNCE_MS = 400;
const DIAGNOSTIC_SOURCE = 'code-groovy';

function compileDiagnosticsEnabled(): boolean {
	return vscode.workspace.getConfiguration('codeGroovy').get<boolean>('compile.diagnostics', true);
}

export class CompileDiagnostics implements vscode.Disposable {
	private readonly collection = vscode.languages.createDiagnosticCollection('codeGroovyCompile');
	private readonly inlineDecoration = vscode.window.createTextEditorDecorationType({});
	private readonly inlineMessages = new Map<string, CompilerDiagnostic[]>();
	private readonly daemon: CompilerDaemonClient;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly generation = new Map<string, number>();
	private jars: string[] = [];
	private workspaceRoot: string | undefined;
	private warned = false;
	private loggedReady = false;
	private stopped = false;

	constructor(daemonDir: string, private readonly log: (message: string) => void) {
		this.daemon = new CompilerDaemonClient(daemonDir, log);
	}

	start(): void {
		this.disposables.push(
			this.collection,
			this.inlineDecoration,
			vscode.workspace.onDidSaveTextDocument(document => {
				if (document.languageId === 'groovy') {
					this.schedule(document);
				}
			}),
			vscode.workspace.onDidOpenTextDocument(document => {
				if (document.languageId === 'groovy') {
					this.schedule(document);
				}
			}),
			vscode.workspace.onDidCloseTextDocument(document => {
				const key = document.uri.toString();
				this.timers.delete(key);
				this.generation.delete(key);
				this.inlineMessages.delete(key);
				this.collection.delete(document.uri);
				this.paintInline(document);
			}),
			vscode.workspace.onDidChangeTextDocument(event => {
				if (event.document.languageId === 'groovy' && this.inlineMessages.has(event.document.uri.toString())) {
					this.paintInline(event.document);
				}
			}),
			vscode.window.onDidChangeVisibleTextEditors(() => this.paintInline()),
			vscode.workspace.onDidChangeConfiguration(event => {
				if (!event.affectsConfiguration('codeGroovy.compile.diagnostics')) {
					return;
				}
				if (!compileDiagnosticsEnabled()) {
					this.collection.clear();
					this.inlineMessages.clear();
					this.paintInline();
					this.daemon.shutdown();
					return;
				}
				for (const document of vscode.workspace.textDocuments) {
					if (document.languageId === 'groovy') {
						this.schedule(document);
					}
				}
			})
		);

		for (const document of vscode.workspace.textDocuments) {
			if (document.languageId === 'groovy') {
				this.schedule(document);
			}
		}
	}

	setProjectClasspath(workspaceRoot: string, jars: string[]): void {
		this.workspaceRoot = workspaceRoot;
		this.jars = jars;
		this.warned = false;
		this.loggedReady = false;
		for (const document of vscode.workspace.textDocuments) {
			if (document.languageId === 'groovy') {
				this.schedule(document);
			}
		}
	}

	dispose(): void {
		this.stopped = true;
		for (const timer of this.timers.values()) {
			clearTimeout(timer);
		}
		this.timers.clear();
		this.daemon.dispose();
		this.disposables.forEach(item => item.dispose());
	}

	private schedule(document: vscode.TextDocument): void {
		const key = document.uri.toString();
		const existing = this.timers.get(key);
		if (existing) {
			clearTimeout(existing);
		}
		this.timers.set(key, setTimeout(() => {
			this.timers.delete(key);
			void this.refresh(document);
		}, DEBOUNCE_MS));
	}

	private async refresh(document: vscode.TextDocument): Promise<void> {
		if (this.stopped || document.languageId !== 'groovy' || document.isClosed) {
			return;
		}
		const key = document.uri.toString();
		const ticket = (this.generation.get(key) ?? 0) + 1;
		this.generation.set(key, ticket);

		if (!compileDiagnosticsEnabled()) {
			this.inlineMessages.delete(key);
			this.collection.set(document.uri, []);
			this.paintInline(document);
			return;
		}

		if (!this.workspaceRoot) {
			return;
		}

		const classpath = this.classpath();
		if (!classpathHasGroovy(classpath)) {
			this.warnOnce('Groovy compiler diagnostics are off until the project classpath includes Groovy.');
			return;
		}

		const filePath = document.uri.scheme === 'file'
			? document.uri.fsPath
			: `${document.uri.path || 'Script'}.groovy`;
		let diagnostics: CompilerDiagnostic[];
		try {
			diagnostics = await this.daemon.compile(filePath, document.getText(), classpath);
		} catch (error) {
			if (this.stopped || !compileDiagnosticsEnabled() || this.generation.get(key) !== ticket) {
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			this.warnOnce(`Groovy compiler diagnostics failed: ${message}`);
			return;
		}

		if (this.stopped || this.generation.get(key) !== ticket || document.isClosed) {
			return;
		}
		if (!this.loggedReady) {
			this.loggedReady = true;
			this.log(`Groovy compiler diagnostics ready (${classpath.length} classpath entries)`);
		}
		this.inlineMessages.set(key, diagnostics);
		this.collection.set(document.uri, diagnostics.map(item => this.toDiagnostic(document, item)));
		this.paintInline(document);
	}

	private paintInline(only?: vscode.TextDocument): void {
		for (const editor of vscode.window.visibleTextEditors) {
			if (only && editor.document.uri.toString() !== only.uri.toString()) {
				continue;
			}
			if (editor.document.languageId !== 'groovy') {
				continue;
			}
			const diagnostics = this.inlineMessages.get(editor.document.uri.toString()) ?? [];
			const decorations: vscode.DecorationOptions[] = [];
			for (const label of inlineErrorLabels(diagnostics)) {
				const line = Math.min(Math.max(label.line - 1, 0), editor.document.lineCount - 1);
				const end = editor.document.lineAt(line).range.end;
				decorations.push({
					range: new vscode.Range(end, end),
					renderOptions: {
						after: {
							contentText: `  ${label.text}`,
							color: new vscode.ThemeColor(label.warning ? 'editorWarning.foreground' : 'editorError.foreground'),
							fontStyle: 'italic',
							margin: '0 0 0 1.5em'
						}
					}
				});
			}
			editor.setDecorations(this.inlineDecoration, decorations);
		}
	}

	private classpath(): string[] {
		if (!this.workspaceRoot) {
			return [];
		}
		return buildCompileClasspath(this.workspaceRoot, this.jars);
	}

	private toDiagnostic(document: vscode.TextDocument, diagnostic: CompilerDiagnostic): vscode.Diagnostic {
		const span = compilerDiagnosticSpan(
			diagnostic,
			document.lineCount,
			line => document.lineAt(line).text.length
		);
		const range = new vscode.Range(span.startLine, span.startCharacter, span.endLine, span.endCharacter);
		const item = new vscode.Diagnostic(
			range,
			diagnostic.message,
			diagnostic.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error
		);
		item.source = DIAGNOSTIC_SOURCE;
		item.code = 'groovy-compile';
		return item;
	}

	private warnOnce(message: string): void {
		if (this.warned) {
			return;
		}
		this.warned = true;
		this.log(message);
		void vscode.window.showWarningMessage(message);
	}
}
