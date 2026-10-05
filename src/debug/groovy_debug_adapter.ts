import * as net from 'net';
import * as vscode from 'vscode';
import {
	collectGrailsImplicitsFromTree,
	DebugVariableNode,
	isMissingJavaProjectError,
	isPurePropertyPath,
	isUsefulEvalResult,
	javaEvaluateExpressions,
	resolveVariablePath,
	rewriteGroovyEvaluate,
	splitPropertyPath
} from './groovy_debug_eval_logic';

interface DapMessage {
	seq?: number;
	type?: string;
	command?: string;
	event?: string;
	request_seq?: number;
	arguments?: any;
	body?: any;
	success?: boolean;
	message?: string;
}

export class GroovyJavaDebugAdapter implements vscode.DebugAdapter {
	private readonly output = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
	private readonly socket: net.Socket;
	private buffer = Buffer.alloc(0);
	private outgoingSeq = 1_000_000;
	private pending = new Map<number, { resolve: (message: DapMessage) => void; reject: (error: Error) => void }>();
	private queue: DapMessage[] = [];
	private connected = false;
	private localScopeRef: number | undefined;
	private frameId: number | undefined;
	private javaEvalBlocked = false;
	private variablesRequestRef = new Map<number, { variablesReference: number; frameId: number | undefined }>();
	private cachedRoots: DebugVariableNode[] | undefined;
	private cachedRootsFrame: number | undefined;
	private javaMessageChain: Promise<void> = Promise.resolve();
	private paramsFallbackUnavailable = false;

	readonly onDidSendMessage = this.output.event;

	constructor(port: number, host = '127.0.0.1') {
		this.socket = net.connect({ port, host });
		this.socket.on('connect', () => {
			this.connected = true;
			for (const message of this.queue) {
				this.write(message);
			}
			this.queue = [];
		});
		this.socket.on('data', (chunk: Buffer) => this.onData(chunk));
		this.socket.on('error', () => {
			this.terminateAdapter('Java debug adapter socket error');
		});
		this.socket.on('close', () => {
			this.terminateAdapter('Java debug adapter disconnected');
		});
	}

	handleMessage(message: vscode.DebugProtocolMessage): void {
		const dap = message as DapMessage;
		if (dap.type === 'request' && (dap.command === 'attach' || dap.command === 'launch') && dap.arguments) {
			dap.arguments.type = 'java';
		}
		if (dap.type === 'request' && dap.command === 'evaluate') {
			void this.answerEvaluate(dap);
			return;
		}
		if (dap.type === 'request' && dap.command === 'scopes' && typeof dap.arguments?.frameId === 'number') {
			this.frameId = dap.arguments.frameId;
			this.cachedRoots = undefined;
		}
		if (dap.type === 'request' && dap.command === 'variables' && typeof dap.seq === 'number') {
			this.variablesRequestRef.set(dap.seq, {
				variablesReference: dap.arguments?.variablesReference,
				frameId: this.frameId
			});
		}
		this.sendToJava(dap);
	}

	dispose(): void {
		this.rejectAll(new Error('Debug adapter disposed'));
		this.socket.destroy();
		this.output.dispose();
	}

	private async answerEvaluate(dap: DapMessage): Promise<void> {
		const expression = typeof dap.arguments?.expression === 'string' ? dap.arguments.expression : '';
		const frameId = typeof dap.arguments?.frameId === 'number' ? dap.arguments.frameId : this.frameId;
		if (frameId !== undefined) {
			this.frameId = frameId;
		}
		this.javaEvalBlocked = false;

		const evalContext = dap.arguments?.context;
		const isAssignmentLike = /[^!<>=]=[^=]/.test(expression) || expression.includes('++') || expression.includes('--');
		if (isAssignmentLike || evalContext === 'repl') {
			dap.arguments.expression = rewriteGroovyEvaluate(expression);
			this.sendToJava(dap);
			return;
		}

		const parts = splitPropertyPath(expression);
		if (isPurePropertyPath(expression) && parts.length && frameId !== undefined) {
			try {
				const roots = await this.loadFrameRoots(frameId);
				const node = await resolveVariablePath(parts, roots, ref => this.loadVars(ref));
				if (node) {
					this.respond(dap, true, {
						result: node.value,
						type: node.type,
						variablesReference: node.variablesReference || 0
					});
					return;
				}
			} catch {
				// fall through to Java evaluate
			}
		}

		const candidates = javaEvaluateExpressions(expression);
		for (const candidate of candidates) {
			const result = await this.evaluate(candidate, 1500);
			if (this.javaEvalBlocked) {
				break;
			}
			if (!isUsefulEvalResult(result)) {
				continue;
			}
			this.respond(dap, true, {
				result: result!.result,
				type: result!.type,
				variablesReference: result!.variablesReference || 0
			});
			return;
		}

		if (expression) {
			dap.arguments.expression = rewriteGroovyEvaluate(expression);
		}
		this.sendToJava(dap);
	}

	private sendToJava(message: DapMessage): void {
		if (!this.connected) {
			this.queue.push(message);
			return;
		}
		this.write(message);
	}

	private write(message: DapMessage): void {
		const json = JSON.stringify(message);
		this.socket.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
	}

	private onData(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		for (const message of this.takeMessages()) {
			this.javaMessageChain = this.javaMessageChain.then(() => this.onJavaMessage(message));
		}
	}

	private takeMessages(): DapMessage[] {
		const messages: DapMessage[] = [];
		while (true) {
			const headerEnd = this.buffer.indexOf('\r\n\r\n');
			if (headerEnd < 0) {
				break;
			}
			const header = this.buffer.slice(0, headerEnd).toString('utf8');
			const match = /Content-Length:\s*(\d+)/i.exec(header);
			if (!match) {
				this.buffer = this.buffer.slice(headerEnd + 4);
				continue;
			}
			const length = Number(match[1]);
			const bodyStart = headerEnd + 4;
			if (this.buffer.length < bodyStart + length) {
				break;
			}
			const body = this.buffer.slice(bodyStart, bodyStart + length).toString('utf8');
			this.buffer = this.buffer.slice(bodyStart + length);
			try {
				messages.push(JSON.parse(body) as DapMessage);
			} catch {
				// skip malformed DAP body
			}
		}
		return messages;
	}

	private async onJavaMessage(message: DapMessage): Promise<void> {
		if (message.type === 'response' && typeof message.request_seq === 'number' && this.pending.has(message.request_seq)) {
			const pending = this.pending.get(message.request_seq);
			this.pending.delete(message.request_seq);
			pending?.resolve(message);
			return;
		}

		if (message.type === 'response' && message.command === 'scopes') {
			const local = (message.body?.scopes || []).find((scope: { name?: string }) => /local/i.test(scope.name || ''));
			this.localScopeRef = local?.variablesReference ?? message.body?.scopes?.[0]?.variablesReference;
		}

		if (message.type === 'response' && message.command === 'variables' && typeof message.request_seq === 'number') {
			const pending = this.variablesRequestRef.get(message.request_seq);
			this.variablesRequestRef.delete(message.request_seq);
			if (
				pending !== undefined
				&& pending.variablesReference === this.localScopeRef
				&& pending.frameId === this.frameId
				&& Array.isArray(message.body?.variables)
			) {
				message.body.variables = await this.withGrailsImplicits(message.body.variables, pending.frameId);
			}
		}

		this.output.fire(message as vscode.DebugProtocolMessage);
	}

	private async withGrailsImplicits(variables: any[], frameId: number | undefined): Promise<any[]> {
		const roots = asNodes(variables);
		this.cachedRoots = roots;
		this.cachedRootsFrame = frameId;
		try {
			const extras = await collectGrailsImplicitsFromTree(roots, ref => this.loadVars(ref));
			let injected = extras.filter(extra => !roots.some(root => root.name === extra.name));
			if (
				!injected.some(item => item.name === 'params')
				&& frameId !== undefined
				&& isGrailsControllerFrame(roots)
				&& !this.paramsFallbackUnavailable
			) {
				const fromEval = await this.evaluateParamsFallback();
				if (fromEval) {
					injected = [fromEval, ...injected];
				} else {
					this.paramsFallbackUnavailable = true;
				}
			}
			if (!injected.length) {
				return variables;
			}
			return [
				...injected.map(extra => ({
					name: extra.name,
					value: extra.value,
					type: extra.type,
					variablesReference: extra.variablesReference,
					evaluateName: extra.evaluateName,
					presentationHint: { kind: 'virtual' }
				})),
				...variables
			];
		} catch {
			return variables;
		}
	}

	private async evaluateParamsFallback(): Promise<{ name: string; value: string; type?: string; variablesReference: number; evaluateName: string } | undefined> {
		for (const expression of javaEvaluateExpressions('params')) {
			if (this.javaEvalBlocked) {
				break;
			}
			const result = await this.evaluate(expression, 1500);
			if (!isUsefulEvalResult(result)) {
				continue;
			}
			return {
				name: 'params',
				value: result!.result!,
				type: result!.type,
				variablesReference: result!.variablesReference || 0,
				evaluateName: expression
			};
		}
		return undefined;
	}

	private async loadFrameRoots(frameId: number): Promise<DebugVariableNode[]> {
		if (this.cachedRoots && this.cachedRootsFrame === frameId) {
			return this.cachedRoots;
		}
		const scopes = await this.javaRequest('scopes', { frameId });
		const roots: DebugVariableNode[] = [];
		for (const scope of scopes.body?.scopes || []) {
			if (!scope.variablesReference) {
				continue;
			}
			roots.push(...await this.loadVars(scope.variablesReference));
		}
		this.cachedRoots = roots;
		this.cachedRootsFrame = frameId;
		return roots;
	}

	private async loadVars(variablesReference: number): Promise<DebugVariableNode[]> {
		const response = await this.javaRequest('variables', { variablesReference });
		return asNodes(response.body?.variables || []);
	}

	private evaluate(
		expression: string,
		timeoutMs = 1500
	): Promise<{ result?: string; type?: string; variablesReference?: number } | undefined> {
		if (!this.frameId) {
			return Promise.resolve(undefined);
		}
		return this.javaRequest('evaluate', {
			expression,
			frameId: this.frameId,
			context: 'watch'
		}, timeoutMs).then(message => {
			if (isMissingJavaProjectError(message.message)) {
				this.javaEvalBlocked = true;
			}
			if (message.success === false || !isUsefulEvalResult(message.body)) {
				return undefined;
			}
			return message.body;
		});
	}

	private javaRequest(command: string, args: object, timeoutMs = 2000): Promise<DapMessage> {
		const seq = this.outgoingSeq++;
		const request: DapMessage = { seq, type: 'request', command, arguments: args };
		return new Promise(resolve => {
			const timer = setTimeout(() => {
				this.pending.delete(seq);
				resolve({ success: false });
			}, timeoutMs);
			this.pending.set(seq, {
				resolve: message => {
					clearTimeout(timer);
					resolve(message);
				},
				reject: () => {
					clearTimeout(timer);
					resolve({ success: false });
				}
			});
			this.sendToJava(request);
		});
	}

	private respond(request: DapMessage, success: boolean, body?: object): void {
		this.output.fire({
			type: 'response',
			request_seq: request.seq,
			success,
			command: request.command,
			body
		} as vscode.DebugProtocolMessage);
	}

	private rejectAll(error: Error): void {
		for (const pending of this.pending.values()) {
			pending.reject(error);
		}
		this.pending.clear();
	}

	private terminateAdapter(reason: string): void {
		this.rejectAll(new Error(reason));
		this.output.fire({ type: 'event', event: 'terminated' } as vscode.DebugProtocolMessage);
	}
}

function isGrailsControllerFrame(roots: DebugVariableNode[]): boolean {
	const self = roots.find(root => root.name === 'this');
	return Boolean(self?.value && /Controller\b/.test(self.value));
}

function asNodes(variables: any[]): DebugVariableNode[] {
	return variables.map(variable => ({
		name: String(variable.name || ''),
		value: String(variable.value ?? ''),
		type: variable.type,
		variablesReference: Number(variable.variablesReference) || 0
	}));
}
