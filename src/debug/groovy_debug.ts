import { GradleRunPseudoterminal } from './gradle_debug_terminal';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as path from 'path';
import * as vscode from 'vscode';
import { GroovyJavaDebugAdapter } from './groovy_debug_adapter';
import { registerGroovyDebugInspection } from './groovy_debug_inspect';
import {
	buildGradleDebugCommand,
	buildInitialDebugConfigurations,
	defaultLaunchName,
	defaultRequest,
	detectDebugProject,
	DetectedDebugProject,
	dynamicDebugConfigurations,
	gradleStartupTimeoutMs,
	GroovyDebugInput,
	GradleDebugStatus,
	hasGradleAppTaskStarted,
	isJdwpListening,
	JAVA_DEBUG_EXTENSION_ID,
	parseDebugPort,
	pickJavaProjectName,
	readGradleDebugStatus,
	resolveAppServerUrl,
	summarizeGradleFailure,
	toJavaAttachConfig
} from './groovy_debug_logic';

export function registerGroovyDebug(context: vscode.ExtensionContext): void {
	try {
		const initScriptDir = path.join(context.globalStorageUri.fsPath, 'gradle-jdwp-init');
		const controller = new GroovyDebugController(initScriptDir);
		context.subscriptions.push(
			controller,
			vscode.debug.registerDebugConfigurationProvider('groovy', controller),
			vscode.debug.registerDebugConfigurationProvider(
				'groovy',
				new GroovyDynamicConfigProvider(),
				vscode.DebugConfigurationProviderTriggerKind.Dynamic
			),
			vscode.debug.registerDebugAdapterDescriptorFactory('groovy', new GroovyDebugAdapterFactory()),
			vscode.debug.registerDebugAdapterTrackerFactory('groovy', new GroovyDebugTrackerFactory()),
			vscode.commands.registerCommand('cgroovy.debugApp', () => controller.startFromCommand())
		);
		registerGroovyDebugInspection(context);
	} catch (error) {
		console.error('Code Groovy debug registration failed', error);
		void vscode.window.showErrorMessage(
			`Code Groovy debug failed to register: ${error instanceof Error ? error.message : String(error)}`
		);
	}
}

class GroovyDebugTrackerFactory implements vscode.DebugAdapterTrackerFactory {
	createDebugAdapterTracker(session: vscode.DebugSession): vscode.DebugAdapterTracker {
		return {
			onDidSendMessage: message => {
				const event = message as { type?: string; event?: string };
				if (event.type === 'event' && event.event === 'continued') {
					GroovyDebugController.notifyDebugContinued(session.name);
				}
			}
		};
	}
}

class GroovyDebugController implements vscode.DebugConfigurationProvider, vscode.Disposable {
	constructor(private readonly initScriptDir: string) {}

	private static continueBeforeBrowser = new Map<string, { promise: Promise<void>; resolve: () => void }>();

	static prepareContinueBeforeBrowser(sessionName: string, enabled: boolean): void {
		GroovyDebugController.continueBeforeBrowser.delete(sessionName);
		if (!enabled) {
			return;
		}
		let resolve!: () => void;
		const promise = new Promise<void>(done => {
			resolve = done;
		});
		GroovyDebugController.continueBeforeBrowser.set(sessionName, { promise, resolve });
	}

	static notifyDebugContinued(sessionName: string): void {
		const gate = GroovyDebugController.continueBeforeBrowser.get(sessionName);
		if (!gate) {
			return;
		}
		gate.resolve();
		GroovyDebugController.continueBeforeBrowser.delete(sessionName);
	}

	private debugTerminal: vscode.Terminal | undefined;
	private gradlePty: GradleRunPseudoterminal | undefined;
	private launchedSessionName: string | undefined;
	private appReadyHandled = false;
	private appReadyInFlight: Promise<void> | undefined;
	private appReadyOptions: { openBrowser: boolean; serverUrl?: string; sessionName?: string } = { openBrowser: true };
	private readonly output = vscode.window.createOutputChannel('Code Groovy Debug');
	private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
	private readonly disposables: vscode.Disposable[] = [
		this.output,
		this.status,
		vscode.debug.onDidTerminateDebugSession(session => {
			if (this.launchedSessionName && session.name === this.launchedSessionName) {
				this.launchedSessionName = undefined;
				this.stopLaunchedProcess();
				this.hideDebugStatus();
			}
		})
	];

	dispose(): void {
		this.stopLaunchedProcess();
		this.hideDebugStatus();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	async resolveDebugConfiguration(
		folder: vscode.WorkspaceFolder | undefined,
		config: vscode.DebugConfiguration,
		token?: vscode.CancellationToken
	): Promise<vscode.DebugConfiguration | undefined> {
		if (config.type && config.type !== 'groovy') {
			return config;
		}

		if (!(await ensureJavaDebugger())) {
			return undefined;
		}

		const project = this.detectProject(folder);
		const input = config as GroovyDebugInput;
		if (!input.request) {
			input.request = defaultRequest(project.kind, Boolean(project.gradlew));
		}
		if (!input.name) {
			input.name = input.request === 'launch' ? defaultLaunchName(project.kind) : 'Groovy: Attach';
		}

		if (input.request === 'launch') {
			const debugPort = parseDebugPort(input.port);
			if (await isDebugPortOpen(debugPort)) {
				const choice = await vscode.window.showWarningMessage(
					`Port ${debugPort} is already in use (often a previous bootRun).`,
					'Attach to existing JVM',
					'Cancel'
				);
				if (choice === 'Attach to existing JVM') {
					input.request = 'attach';
					if (!input.name || input.name.startsWith('Groovy: Launch')) {
						input.name = 'Groovy: Attach';
					}
				} else {
					return undefined;
				}
			} else {
				const started = await this.launchGradle(project, input, token);
				if (!started) {
					return undefined;
				}
			}
		}

		input.projectName = pickJavaProjectName({
			configured: input.projectName,
			launchModule: input.module || project.launchModule,
			projectRoot: project.projectRoot,
			jdtNames: await listJdtProjectNames()
		});
		const javaConfig = toJavaAttachConfig(
			input,
			project.sourcePaths,
			input.request === 'launch' ? defaultLaunchName(project.kind) : 'Groovy: Attach'
		);
		if (input.request === 'launch') {
			this.launchedSessionName = javaConfig.name;
			const jdwpSuspend = input.jdwpSuspend === 'y' ? 'y' : 'n';
			GroovyDebugController.prepareContinueBeforeBrowser(javaConfig.name, jdwpSuspend === 'y');
		}
		return {
			...javaConfig,
			type: 'groovy'
		};
	}

	async startFromCommand(): Promise<void> {
		const editorFolder = vscode.window.activeTextEditor
			? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)
			: undefined;
		const folder = editorFolder ?? vscode.workspace.workspaceFolders?.[0];
		const project = this.detectProject(folder);
		const request = defaultRequest(project.kind, Boolean(project.gradlew));
		await vscode.debug.startDebugging(folder, {
			type: 'groovy',
			request,
			name: request === 'launch' ? defaultLaunchName(project.kind) : 'Groovy: Attach'
		});
	}

	private detectProject(folder: vscode.WorkspaceFolder | undefined): DetectedDebugProject {
		const workspaceRoot = folder?.uri.fsPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			return {
				kind: 'unknown',
				projectRoot: '',
				sourcePaths: []
			};
		}

		const configuredModules = vscode.workspace.getConfiguration('codeGroovy').get<string[]>('modules', ['domain', 'web', 'api']);
		return detectDebugProject(workspaceRoot, configuredModules);
	}

	private async launchGradle(
		project: DetectedDebugProject,
		input: GroovyDebugInput,
		token?: vscode.CancellationToken
	): Promise<boolean> {
		const debugConfig = vscode.workspace.getConfiguration('codeGroovy');
		const jdwpWaitMs = debugConfig.get<number>('debug.attachTimeoutMs', 600_000);
		const debugPort = parseDebugPort(input.port);
		input.useBootRunDebugJvm = debugConfig.get<boolean>('debug.useBootRunDebugJvm', false);
		input.gradleConsole = debugConfig.get<'rich' | 'plain'>('debug.gradleConsole', 'rich');
		input.jdwpSuspend = input.jdwpSuspend ?? debugConfig.get<'y' | 'n'>('debug.jdwpSuspend', 'n');
		this.appReadyHandled = false;
		this.appReadyOptions = {
			openBrowser: input.openBrowserOnReady ?? debugConfig.get<boolean>('debug.openBrowserOnReady', true),
			serverUrl: (input.serverUrl || debugConfig.get<string>('debug.serverUrl', '')).trim() || undefined,
			sessionName: input.name
		};

		let command;
		try {
			command = buildGradleDebugCommand(project, input, this.initScriptDir);
		} catch (error) {
			void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
			return false;
		}
		if (!command) {
			void vscode.window.showErrorMessage(
				'No Gradle wrapper found. Start the app with JDWP and use Groovy: Attach, or open a Gradle project.'
			);
			return false;
		}

		this.stopLaunchedProcess();
		this.hideDebugStatus();
		this.output.clear();
		this.output.appendLine(`${command.command} ${command.args.join(' ')}`);
		this.output.appendLine(`cwd: ${command.cwd}`);
		this.setDebugStatus({ phase: 'starting', message: 'Starting Gradle…' });

		return vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Groovy debug',
				cancellable: true
			},
			async (progress, progressToken) => {
				const { token: combined, dispose: disposeMerged } = token
					? mergeCancellation(token, progressToken)
					: { token: progressToken, dispose: () => undefined };
				try {
					return await this.spawnAndWaitForJdwp(
					command.command,
					command.args,
					command.cwd,
					jdwpWaitMs,
					debugPort,
					combined,
					progress,
					this.appReadyOptions.serverUrl
					);
				} finally {
					disposeMerged();
				}
			}
		);
	}

	private spawnAndWaitForJdwp(
		command: string,
		args: string[],
		cwd: string,
		jdwpWaitMs: number,
		debugPort: number,
		token: vscode.CancellationToken,
		progress: vscode.Progress<{ message?: string }>,
		configuredServerUrl?: string
	): Promise<boolean> {
		return new Promise(resolve => {
			let settled = false;
			let buffer = '';
			let pollTimer: NodeJS.Timeout | undefined;
			let appTaskStarted = false;
			let lastProgress = '';
			let notifiedBuild = false;
			let notifiedRunning = false;
			const launchTimeoutMs = gradleStartupTimeoutMs(jdwpWaitMs);

			const clearTimers = () => {
				clearTimeout(launchTimer);
				if (pollTimer) {
					clearInterval(pollTimer);
				}
			};

			const trimBuffer = () => {
				const max = 200_000;
				if (buffer.length > max) {
					buffer = buffer.slice(-max);
				}
			};

			const finish = (ok: boolean, message?: string) => {
				if (settled) {
					return;
				}
				settled = true;
				cancelListener.dispose();
				trimBuffer();
				clearTimers();
				if (!ok) {
					this.launchedSessionName = undefined;
					this.stopLaunchedProcess();
					this.hideDebugStatus();
					if (message) {
						void vscode.window.showErrorMessage(message);
					}
				} else {
					this.debugTerminal?.show(false);
				}
				resolve(ok);
			};

			const cancelListener = token.onCancellationRequested(() => {
				finish(false, 'Groovy debug start cancelled.');
			});
			if (token.isCancellationRequested) {
				finish(false, 'Groovy debug start cancelled.');
				return;
			}

			const launchTimer = setTimeout(() => {
				finish(
					false,
					`Timed out waiting for JDWP on port ${debugPort} after ${Math.round(launchTimeoutMs / 1000)}s. Check the Code Groovy Debug output (bootRun can run a long time before the JVM opens the port). Increase codeGroovy.debug.attachTimeoutMs if needed.`
				);
			}, launchTimeoutMs);

			const startPortPoll = () => {
				if (pollTimer) {
					return;
				}
				pollTimer = setInterval(() => {
					if (settled) {
						return;
					}
					void isDebugPortOpen(debugPort).then(open => {
						if (open) {
							finish(true);
						}
					});
				}, 400);
			};

			const noteAppTaskStarted = () => {
				if (appTaskStarted || settled) {
					return;
				}
				appTaskStarted = true;
				progress.report({ message: 'bootRun started — waiting for JVM debug port…' });
				startPortPoll();
			};

			const tryFinishOnJdwp = () => {
				if (isJdwpListening(buffer)) {
					finish(true);
				}
			};

			const onChunk = (text: string) => {
				if (!settled) {
					buffer += text;
					trimBuffer();
				}
				if (hasGradleAppTaskStarted(buffer)) {
					noteAppTaskStarted();
				}
				const status = readGradleDebugStatus(buffer);
				this.setDebugStatus(status);
				if (!settled && status.message !== lastProgress) {
					lastProgress = status.message;
					progress.report({ message: status.message });
				}
				if (!notifiedBuild && status.phase === 'jdwp') {
					notifiedBuild = true;
					void vscode.window.showInformationMessage('Debug JVM is listening.');
				}
				if (!notifiedRunning && status.phase === 'running') {
					notifiedRunning = true;
					void this.scheduleApplicationReady(buffer, configuredServerUrl, progress);
				}
				tryFinishOnJdwp();
			};

			const pty = new GradleRunPseudoterminal(
				command,
				args,
				cwd,
				onChunk,
				code => {
					if (settled) {
						return;
					}
					void this.handleGradleProcessExit(code, debugPort, buffer, finish);
				},
			);
			this.gradlePty = pty;
			this.debugTerminal?.dispose();
			this.debugTerminal = vscode.window.createTerminal({
				name: 'Groovy Debug',
				pty,
				iconPath: new vscode.ThemeIcon('debug-alt')
			});
			this.debugTerminal.show(true);
		});
	}

	private scheduleApplicationReady(
		buffer: string,
		configuredServerUrl: string | undefined,
		progress: vscode.Progress<{ message?: string }>
	): void {
		if (this.appReadyHandled || this.appReadyInFlight) {
			return;
		}
		this.appReadyInFlight = this.handleApplicationReady(buffer, configuredServerUrl, progress).finally(() => {
			this.appReadyInFlight = undefined;
		});
	}

	private async handleApplicationReady(
		buffer: string,
		configuredServerUrl: string | undefined,
		progress: vscode.Progress<{ message?: string }>
	): Promise<void> {
		if (this.appReadyHandled) {
			return;
		}
		const url = resolveAppServerUrl(buffer, configuredServerUrl);
		if (!url) {
			void vscode.window.showInformationMessage(
				'Application startup line detected. Set codeGroovy.debug.serverUrl or serverUrl in launch.json to probe HTTP and open the browser.'
			);
			return;
		}

		progress.report({ message: `Waiting for ${url} to respond…` });
		this.setDebugStatus({ phase: 'running', message: `Waiting for ${url}…` });

		const sessionName = this.appReadyOptions.sessionName ?? this.launchedSessionName;
		const continueGate = sessionName ? GroovyDebugController.continueBeforeBrowser.get(sessionName) : undefined;
		if (continueGate) {
			progress.report({ message: 'Press Continue (F5) in the debugger so the app can finish starting…' });
			await Promise.race([
				continueGate.promise,
				sleep(600_000)
			]);
		}

		const ready = await waitForHttpReady(url, 300_000);
		if (!ready) {
			void vscode.window.showWarningMessage(
				`App log says it started but ${url} did not respond within 5 minutes.`
			);
			return;
		}

		this.appReadyHandled = true;
		this.setDebugStatus({ phase: 'running', message: `Ready · ${url}` });
		const openLabel = 'Open in browser';
		if (this.appReadyOptions.openBrowser) {
			await vscode.env.openExternal(vscode.Uri.parse(url));
		}
		void vscode.window.showInformationMessage(`Application ready at ${url}`, openLabel).then(choice => {
			if (choice === openLabel) {
				void vscode.env.openExternal(vscode.Uri.parse(url));
			}
		});
	}

	private async handleGradleProcessExit(
		code: number | null,
		debugPort: number,
		buffer: string,
		finish: (ok: boolean, message?: string) => void
	): Promise<void> {
		for (let attempt = 0; attempt < 20; attempt++) {
			if (await isDebugPortOpen(debugPort)) {
				finish(true);
				return;
			}
			await sleep(250);
		}
		const summary = summarizeGradleFailure(buffer);
		finish(
			false,
			summary
				?? `Gradle exited before the app opened a debug port (code ${code}). Check the Code Groovy Debug output. Port ${debugPort} may already be in use.`
		);
	}

	private setDebugStatus(status: GradleDebugStatus): void {
		const icons: Record<GradleDebugStatus['phase'], string> = {
			starting: '$(sync~spin)',
			compiling: '$(sync~spin)',
			compiled: '$(check)',
			jdwp: '$(debug-alt)',
			running: '$(play)',
			failed: '$(error)'
		};
		this.status.text = `${icons[status.phase]} Groovy: ${status.message}`;
		this.status.tooltip = 'Code Groovy debug';
		this.status.show();
	}

	private hideDebugStatus(): void {
		this.status.hide();
	}

	private stopLaunchedProcess(): void {
		this.gradlePty?.killChild();
		this.gradlePty = undefined;
	}
}

class GroovyDynamicConfigProvider implements vscode.DebugConfigurationProvider {
	provideDebugConfigurations(
		folder: vscode.WorkspaceFolder | undefined,
		_token?: vscode.CancellationToken
	): vscode.ProviderResult<vscode.DebugConfiguration[]> {
		const existing = vscode.workspace.getConfiguration('launch', folder).get<Array<{ type?: string }>>('configurations');
		return dynamicDebugConfigurations(buildInitialDebugConfigurations(), existing);
	}
}

async function ensureJavaDebugger(): Promise<boolean> {
	const javaDebug = vscode.extensions.getExtension(JAVA_DEBUG_EXTENSION_ID);
	if (!javaDebug) {
		const choice = await vscode.window.showErrorMessage(
			'Debugging Groovy/Grails requires the Debugger for Java extension.',
			'Install'
		);
		if (choice === 'Install') {
			await vscode.commands.executeCommand('workbench.extensions.installExtension', JAVA_DEBUG_EXTENSION_ID);
			void vscode.window.showInformationMessage('Install Debugger for Java, then start debug again.');
		}
		return false;
	}
	return true;
}

class GroovyDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
	async createDebugAdapterDescriptor(
		_session: vscode.DebugSession,
		_executable: vscode.DebugAdapterExecutable | undefined
	): Promise<vscode.DebugAdapterDescriptor> {
		if (!(await ensureJavaDebugger())) {
			throw new Error('Debugger for Java is not installed.');
		}
		const port = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Starting Java debug adapter…'
			},
			() => waitForJavaDebugPort()
		);
		return new vscode.DebugAdapterInlineImplementation(new GroovyJavaDebugAdapter(port));
	}
}

async function waitForJavaDebugPort(): Promise<number> {
	const redhat = vscode.extensions.getExtension('redhat.java');
	const javaDebug = vscode.extensions.getExtension(JAVA_DEBUG_EXTENSION_ID);
	if (redhat) {
		const api = await redhat.activate() as { serverReady?: () => Thenable<void> } | undefined;
		if (api && typeof api.serverReady === 'function') {
			await api.serverReady();
		}
	}
	if (javaDebug && !javaDebug.isActive) {
		await javaDebug.activate();
	}

	const commandNames = ['vscode.java.startDebugSession', 'java.startDebugSession'];
	let lastError: Error | undefined;
	const maxAttempts = 150;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const available = await vscode.commands.getCommands(true);
		for (const name of commandNames) {
			if (!available.includes(name)) {
				continue;
			}
			try {
				const port = await vscode.commands.executeCommand(name);
				if (typeof port === 'number' && port > 0) {
					return port;
				}
				lastError = new Error(`${name} returned ${String(port)}`);
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
			}
		}
		await sleep(400);
	}

	throw lastError ?? new Error(
		'Java language server did not start a debug port. Wait until Language Support for Java finishes loading, then try again.'
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForHttpReady(url: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await probeHttpOnce(url)) {
			return true;
		}
		await sleep(750);
	}
	return false;
}

function probeHttpOnce(url: string): Promise<boolean> {
	return new Promise(resolve => {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			resolve(false);
			return;
		}
		const lib = parsed.protocol === 'https:' ? https : http;
		const req = lib.request(
			{
				hostname: parsed.hostname,
				port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
				path: `${parsed.pathname || '/'}${parsed.search}`,
				method: 'GET',
				timeout: 4000
			},
			res => {
				res.resume();
				resolve(res.statusCode !== undefined && res.statusCode > 0 && res.statusCode < 500);
			}
		);
		req.on('timeout', () => {
			req.destroy();
			resolve(false);
		});
		req.on('error', () => resolve(false));
		req.end();
	});
}

async function listJdtProjectNames(): Promise<string[]> {
	try {
		const uris = await vscode.commands.executeCommand<string[]>('java.project.getAll');
		if (!Array.isArray(uris)) {
			return [];
		}
		return uris
			.map(uri => {
				try {
					return path.basename(vscode.Uri.parse(uri).fsPath);
				} catch {
					return path.basename(String(uri).replace(/\/$/, ''));
				}
			})
			.filter(Boolean);
	} catch {
		return [];
	}
}

async function isDebugPortOpen(port: number): Promise<boolean> {
	for (const host of ['127.0.0.1', '::1']) {
		if (await isDebugPortOpenOnHost(host, port)) {
			return true;
		}
	}
	return false;
}

function isDebugPortOpenOnHost(host: string, port: number): Promise<boolean> {
	return new Promise(resolve => {
		const socket = net.connect({ host, port }, () => {
			socket.destroy();
			resolve(true);
		});
		socket.setTimeout(800, () => {
			socket.destroy();
			resolve(false);
		});
		socket.on('error', () => {
			socket.destroy();
			resolve(false);
		});
	});
}

function mergeCancellation(
	first: vscode.CancellationToken,
	second: vscode.CancellationToken
): { token: vscode.CancellationToken; dispose: () => void } {
	const source = new vscode.CancellationTokenSource();
	const d1 = first.onCancellationRequested(() => source.cancel());
	const d2 = second.onCancellationRequested(() => source.cancel());
	if (first.isCancellationRequested || second.isCancellationRequested) {
		source.cancel();
	}
	return {
		token: source.token,
		dispose: () => {
			d1.dispose();
			d2.dispose();
			source.dispose();
		}
	};
}
