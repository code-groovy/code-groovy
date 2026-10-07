import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	CompilerDiagnostic,
	DIAGNOSTIC_PREFIX,
	javaCommandFromEnv,
	parseDaemonMessage
} from './compile_diagnostic_logic';

const COMPILE_TIMEOUT_MS = 60_000;

interface PendingCompile {
	resolve: (diagnostics: CompilerDiagnostic[]) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class CompilerDaemonClient {
	private child: ChildProcessWithoutNullStreams | undefined;
	private buffer = '';
	private stderr = '';
	private nextId = 1;
	private readonly pending = new Map<string, PendingCompile>();
	private chain: Promise<unknown> = Promise.resolve();
	private disposed = false;

	constructor(
		private readonly daemonDir: string,
		private readonly log: (message: string) => void,
		private readonly cwd: string = os.tmpdir()
	) {}

	compile(filePath: string, source: string, classpath: string[]): Promise<CompilerDiagnostic[]> {
		const run = this.chain.then(() => this.compileNow(filePath, source, classpath));
		this.chain = run.then(() => undefined, () => undefined);
		return run;
	}

	/** Kill the current JVM. The next compile starts another one. */
	shutdown(): void {
		this.stop('Compiler daemon stopped');
	}

	dispose(): void {
		this.disposed = true;
		this.shutdown();
	}

	private async compileNow(filePath: string, source: string, classpath: string[]): Promise<CompilerDiagnostic[]> {
		if (this.disposed) {
			throw new Error('Compiler daemon stopped');
		}
		const child = this.ensureStarted();
		const id = String(this.nextId++);
		const request = JSON.stringify({ id, path: filePath, source, classpath });
		const response = new Promise<CompilerDiagnostic[]>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				this.stop('Groovy compiler timed out');
				reject(new Error('Groovy compiler timed out'));
			}, COMPILE_TIMEOUT_MS);
			this.pending.set(id, { resolve, reject, timer });
		});
		child.stdin.write(DIAGNOSTIC_PREFIX + request + '\n');
		return response;
	}

	private ensureStarted(): ChildProcessWithoutNullStreams {
		if (this.child && !this.child.killed && this.child.exitCode === null) {
			return this.child;
		}
		const classFile = path.join(this.daemonDir, 'CompilerDaemon.class');
		if (!fs.existsSync(classFile)) {
			throw new Error(`Groovy compiler daemon is missing (${classFile}). Run npm run compile.`);
		}
		const java = javaCommandFromEnv(process.env, candidate => fs.existsSync(candidate));
		const child = spawn(java, ['-Dfile.encoding=UTF-8', '-cp', this.daemonDir, 'CompilerDaemon'], {
			cwd: this.cwd,
			stdio: ['pipe', 'pipe', 'pipe']
		});
		this.child = child;
		this.buffer = '';
		this.stderr = '';

		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => {
			this.stderr = (this.stderr + chunk).slice(-4000);
		});
		child.on('error', error => {
			this.log(`Groovy compiler failed to start: ${error.message}`);
			this.rejectAll(error);
		});
		child.on('close', code => {
			if (this.child === child) {
				this.child = undefined;
			}
			if (this.pending.size > 0) {
				const detail = this.stderr.trim();
				this.rejectAll(new Error(detail || `Groovy compiler exited (${code ?? 'unknown'})`));
			}
		});
		return child;
	}

	private onStdout(chunk: string): void {
		this.buffer += chunk;
		let newline = this.buffer.indexOf('\n');
		while (newline >= 0) {
			const line = this.buffer.slice(0, newline).replace(/\r$/, '');
			this.buffer = this.buffer.slice(newline + 1);
			this.onLine(line);
			newline = this.buffer.indexOf('\n');
		}
	}

	private onLine(line: string): void {
		const message = parseDaemonMessage(line);
		if (!message?.id) {
			return;
		}
		const pending = this.pending.get(message.id);
		if (!pending) {
			return;
		}
		clearTimeout(pending.timer);
		this.pending.delete(message.id);
		if (message.error) {
			pending.reject(new Error(message.error));
			return;
		}
		pending.resolve(message.diagnostics ?? []);
	}

	private stop(reason: string): void {
		const child = this.child;
		this.child = undefined;
		if (child && child.exitCode === null) {
			child.kill();
		}
		if (this.pending.size > 0) {
			this.rejectAll(new Error(reason));
		}
	}

	private rejectAll(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}
}
