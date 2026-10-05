import { ChildProcess, spawn } from 'child_process';
import * as vscode from 'vscode';

/** Runs Gradle bootRun in an integrated terminal so ANSI colors and logs stay visible. */
export class GradleRunPseudoterminal implements vscode.Pseudoterminal {
	private readonly writeEmitter = new vscode.EventEmitter<string>();
	private readonly closeEmitter = new vscode.EventEmitter<number>();
	private child: ChildProcess | undefined;
	private opened = false;

	readonly onDidWrite = this.writeEmitter.event;
	readonly onDidClose = this.closeEmitter.event;

	constructor(
		private readonly command: string,
		private readonly args: string[],
		private readonly cwd: string,
		private readonly onOutputChunk: (text: string) => void,
		private readonly onProcessExit: (code: number | null) => void,
	) {}

	open(): void {
		if (this.opened) {
			return;
		}
		this.opened = true;
		this.writeEmitter.fire(`\r\n\x1b[90m$ ${this.command} ${this.args.join(' ')}\x1b[0m\r\n\r\n`);

		const env = {
			...process.env,
			FORCE_COLOR: '1',
			CLICOLOR_FORCE: '1',
			TERM: process.env.TERM || 'xterm-256color'
		};
		const child = spawn(this.command, this.args, {
			cwd: this.cwd,
			env,
			shell: false,
			windowsHide: true,
			detached: false
		});
		this.child = child;

		const onChunk = (chunk: Buffer) => {
			const text = chunk.toString('utf8');
			this.writeEmitter.fire(text.replace(/\r?\n/g, '\r\n'));
			this.onOutputChunk(text);
		};
		child.stdout?.on('data', onChunk);
		child.stderr?.on('data', onChunk);
		child.on('error', err => {
			this.writeEmitter.fire(`\r\n\x1b[31m${err.message}\x1b[0m\r\n`);
		});
		child.on('close', code => {
			this.onProcessExit(code);
			this.closeEmitter.fire(code ?? 0);
			this.opened = false;
		});
	}

	close(): void {
		this.killChild();
	}

	handleInput(data: string): void {
		if (data === '\x03' || data === '\u0003') {
			this.child?.kill('SIGINT');
			return;
		}
		this.child?.stdin?.write(data);
	}

	getProcess(): ChildProcess | undefined {
		return this.child;
	}

	killChild(): void {
		const child = this.child;
		this.child = undefined;
		if (!child?.pid) {
			return;
		}
		if (process.platform === 'win32') {
			spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
			return;
		}
		child.kill('SIGTERM');
	}
}
