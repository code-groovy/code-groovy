import * as fs from 'fs';
import * as path from 'path';
import { detectGrailsModules, GrailsModule } from '../groovy/grails_module_detector';

export const DEFAULT_DEBUG_PORT = 5005;
export const JAVA_DEBUG_EXTENSION_ID = 'vscjava.vscode-java-debug';

export type GroovyDebugProjectKind = 'grails' | 'micronaut' | 'gradle' | 'unknown';

export interface GroovyDebugInput {
	request?: string;
	name?: string;
	hostName?: string;
	port?: number | string;
	task?: string;
	module?: string;
	sourcePaths?: string[];
	gradleArgs?: string[];
	projectName?: string;
	/** Pass `--debug-jvm` to bootRun (Spring Boot plugin only; breaks some Grails builds). */
	useBootRunDebugJvm?: boolean;
	/** Override app URL for readiness probe / browser (e.g. http://localhost:8080). */
	serverUrl?: string;
	openBrowserOnReady?: boolean;
	/** Gradle `--console` (default rich — colored logs in the debug terminal). */
	gradleConsole?: 'rich' | 'plain';
}

export type GradleConsoleMode = 'rich' | 'plain';

export interface DetectedDebugProject {
	kind: GroovyDebugProjectKind;
	projectRoot: string;
	gradlew?: string;
	launchTask?: string;
	launchModule?: string;
	sourcePaths: string[];
}

export interface JavaAttachConfig {
	type: 'java';
	request: 'attach';
	name: string;
	hostName: string;
	port: number;
	sourcePaths: string[];
	projectName?: string;
}

export interface GradleDebugCommand {
	command: string;
	args: string[];
	cwd: string;
}

const PREFERRED_BOOT_MODULES = ['web', 'api', 'app'];

const ROOT_SOURCE_CANDIDATES = [
	'grails-app',
	path.join('src', 'main', 'groovy'),
	path.join('src', 'main', 'java'),
	path.join('src', 'test', 'groovy'),
	path.join('src', 'test', 'java'),
	path.join('src', 'integration-test', 'groovy'),
	path.join('src', 'integration-test', 'java')
];

export function parseDebugPort(value: number | string | undefined, fallback = DEFAULT_DEBUG_PORT): number {
	if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
		return value;
	}
	if (typeof value === 'string' && value.trim()) {
		const parsed = Number(value);
		if (Number.isInteger(parsed) && parsed > 0) {
			return parsed;
		}
	}
	return fallback;
}

export function findGradleWrapper(startDir: string, platform: NodeJS.Platform = process.platform): string | undefined {
	let current = startDir;
	for (let depth = 0; depth < 6; depth++) {
		const win = path.join(current, 'gradlew.bat');
		const unix = path.join(current, 'gradlew');
		if (platform === 'win32' && fs.existsSync(win)) {
			return win;
		}
		if (fs.existsSync(unix)) {
			return unix;
		}
		if (fs.existsSync(win)) {
			return win;
		}
		const parent = path.dirname(current);
		if (parent === current) {
			break;
		}
		current = parent;
	}
	return undefined;
}

export function detectDebugProject(
	workspaceRoot: string,
	configuredModules: string[] = ['domain', 'web', 'api']
): DetectedDebugProject {
	const gradlew = findGradleWrapper(workspaceRoot);
	const projectRoot = gradlew ? path.dirname(gradlew) : workspaceRoot;
	const folders = [{ uri: { fsPath: workspaceRoot } }];
	if (projectRoot !== workspaceRoot) {
		folders.push({ uri: { fsPath: projectRoot } });
	}
	const modules = detectGrailsModules(folders, configuredModules);
	const sourcePaths = collectDebugSourcePaths(workspaceRoot, modules);
	if (projectRoot !== workspaceRoot) {
		for (const extra of collectDebugSourcePaths(projectRoot, modules)) {
			if (!sourcePaths.includes(extra)) {
				sourcePaths.push(extra);
			}
		}
	}
	const bootModule = pickBootRunModule(modules);
	const kind = detectProjectKind(workspaceRoot, modules, projectRoot);

	return {
		kind,
		projectRoot,
		gradlew,
		launchTask: kind === 'grails' ? 'bootRun' : kind === 'unknown' ? undefined : 'run',
		launchModule: kind === 'grails' ? bootModule?.name : undefined,
		sourcePaths
	};
}

export function collectDebugSourcePaths(workspaceRoot: string, modules: GrailsModule[] = []): string[] {
	const paths: string[] = [];
	for (const module of modules) {
		for (const sourcePath of module.sourcePaths) {
			pushUnique(paths, sourcePath);
		}
	}
	for (const relative of ROOT_SOURCE_CANDIDATES) {
		const candidate = path.join(workspaceRoot, relative);
		if (fs.existsSync(candidate)) {
			pushUnique(paths, candidate);
		}
	}
	return paths;
}

export function buildGradleDebugCommand(
	project: DetectedDebugProject,
	input: GroovyDebugInput = {},
	initScriptDir?: string
): GradleDebugCommand | undefined {
	if (!project.gradlew) {
		return undefined;
	}

	const task = (input.task || project.launchTask || 'bootRun').trim();
	const module = (input.module || project.launchModule || '').trim();
	const gradleTask = task.includes(':')
		? task
		: module
			? `:${module}:${task}`
			: task;

	const port = parseDebugPort(input.port);
	const gradleArgs = input.gradleArgs || [];
	const consoleMode: GradleConsoleMode = input.gradleConsole === 'plain' ? 'plain' : 'rich';
	const consoleFlag = gradleArgs.some(arg => arg === '--console=plain' || arg.startsWith('--console='))
		? []
		: [`--console=${consoleMode}`];
	const bootDebug = bootRunDebugJvmFlags(gradleTask, gradleArgs, input.useBootRunDebugJvm);

	if (!initScriptDir) {
		throw new Error('Code Groovy debug requires an extension storage directory for the Gradle init script.');
	}
	fs.mkdirSync(initScriptDir, { recursive: true });
	const initFile = path.join(initScriptDir, `code-groovy-jdwp-${port}-${process.pid}.gradle`);
	try {
		fs.writeFileSync(initFile, gradleJavaExecJdwpInitScript(port, gradleTask), { mode: 0o600 });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not write Gradle JDWP init script: ${message}`);
	}

	return {
		command: project.gradlew,
		args: [gradleTask, ...consoleFlag, ...bootDebug, '-I', initFile, ...gradleArgs],
		cwd: project.projectRoot
	};
}

/**
 * Spring Boot 2.2+ bootRun accepts `--debug-jvm`; many Grails/Gradle setups reject it (Gradle exit 1).
 * Off by default — JDWP comes from the init script on JavaExec bootRun/run.
 */
export function bootRunDebugJvmFlags(
	gradleTask: string,
	gradleArgs: string[] = [],
	enabled = false
): string[] {
	if (!enabled || !isBootRunLikeGradleTask(gradleTask)) {
		return [];
	}
	if (gradleArgs.some(arg => arg === '--debug-jvm' || arg === '-debug-jvm')) {
		return [];
	}
	return ['--debug-jvm'];
}

export function isBootRunLikeGradleTask(gradleTask: string): boolean {
	return /(?:^|:)(?:bootRun|run)$/i.test(gradleTask.trim());
}

export function jdwpAgentLib(port: number = DEFAULT_DEBUG_PORT): string {
	// Use 127.0.0.1 — `address=*:port` breaks on some JVMs (gethostbyname: unknown host).
	return `-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:${port}`;
}

export function gradleJavaExecJdwpInitScript(port: number = DEFAULT_DEBUG_PORT, gradleTaskPath = ':web:bootRun'): string {
	const agent = jdwpAgentLib(port).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
	const taskPath = gradleTaskPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
	return `
def codeGroovyJdwpAgent = '${agent}'
def codeGroovyTargetTaskPath = '${taskPath}'

gradle.taskGraph.whenReady { graph ->
  def target = graph.allTasks.find { it.path == codeGroovyTargetTaskPath }
  if (target instanceof org.gradle.api.tasks.JavaExec) {
    target.doFirst {
      if ((target.jvmArgs ?: []).any { it.toString().contains('jdwp') }) {
        return
      }
      target.jvmArgs(codeGroovyJdwpAgent)
    }
  }
}
`.trim() + '\n';
}

export function summarizeGradleFailure(output: string): string | undefined {
	if (/Unknown command-line option '--debug-jvm'/i.test(output)) {
		return 'Gradle rejected --debug-jvm for this project. Leave codeGroovy.debug.useBootRunDebugJvm disabled (default).';
	}
	const what = /\* What went wrong:\s*\n(?:(?:\* )?([^\n]+(?:\n(?!\* ).+)*))/i.exec(output);
	if (what?.[1]) {
		return what[1].trim().split('\n').slice(0, 4).join(' ').slice(0, 400);
	}
	if (/BUILD FAILED/i.test(output) || /FAILURE: Build failed/i.test(output)) {
		return 'Gradle build failed — see Code Groovy Debug output for details.';
	}
	return undefined;
}

export function toJavaAttachConfig(
	input: GroovyDebugInput,
	sourcePaths: string[],
	defaultName = 'Groovy: Attach'
): JavaAttachConfig {
	const projectName = (input.projectName || '').trim();
	return {
		type: 'java',
		request: 'attach',
		name: input.name || defaultName,
		hostName: (input.hostName || 'localhost').trim() || 'localhost',
		port: parseDebugPort(input.port),
		sourcePaths: input.sourcePaths?.length ? uniquePaths(input.sourcePaths) : uniquePaths(sourcePaths),
		...(projectName ? { projectName } : {})
	};
}

export function pickJavaProjectName(input: {
	configured?: string;
	launchModule?: string;
	projectRoot?: string;
	jdtNames?: string[];
}): string | undefined {
	const configured = input.configured?.trim();
	if (configured) {
		return configured;
	}
	const jdtNames = input.jdtNames || [];
	const preferred = [
		input.launchModule?.trim(),
		input.projectRoot ? path.basename(input.projectRoot) : undefined
	].filter((name): name is string => Boolean(name));

	for (const name of preferred) {
		if (jdtNames.includes(name)) {
			return name;
		}
	}
	for (const name of preferred) {
		const match = jdtNames.find(candidate =>
			candidate === name
			|| candidate.endsWith(`.${name}`)
			|| candidate.endsWith(`-${name}`)
		);
		if (match) {
			return match;
		}
	}
	return preferred[0] || jdtNames[0];
}

export function defaultLaunchName(kind: GroovyDebugProjectKind): string {
	if (kind === 'grails') {
		return 'Groovy: Launch Grails';
	}
	if (kind === 'micronaut') {
		return 'Groovy: Launch Micronaut';
	}
	return 'Groovy: Launch';
}

export function defaultRequest(kind: GroovyDebugProjectKind, hasGradlew: boolean): 'launch' | 'attach' {
	return kind !== 'unknown' && hasGradlew ? 'launch' : 'attach';
}

export type GradleDebugPhase = 'starting' | 'compiling' | 'compiled' | 'jdwp' | 'running' | 'failed';

export interface GradleDebugStatus {
	phase: GradleDebugPhase;
	message: string;
	task?: string;
}

export function isJdwpListening(output: string): boolean {
	return /Listening for transport dt_socket/i.test(output);
}

/** True once Gradle has started bootRun/run (app JVM may not be up yet). */
export function hasGradleAppTaskStarted(output: string): boolean {
	const task = lastGradleTask(output);
	return task !== undefined && isBootOrRunTask(task);
}

/** Total time to wait for Gradle compile + bootRun JVM + JDWP (first run can be slow). */
export function gradleStartupTimeoutMs(configuredMs: number): number {
	if (typeof configuredMs === 'number' && Number.isFinite(configuredMs) && configuredMs > 0) {
		return configuredMs;
	}
	return 600_000;
}

export function isAppRunning(output: string): boolean {
	return /Grails application running at/i.test(output)
		|| /Started \S+ in \d+(?:\.\d+)? seconds/i.test(output)
		|| /Tomcat started on port/i.test(output)
		|| /Netty started on port/i.test(output)
		|| /Startup completed in/i.test(output);
}

/** Best URL to open when the app is ready (Grails / Spring Boot log lines). */
export function extractAppReadyUrl(output: string): string | undefined {
	const grails = /Grails application running at (https?:\/\/[^\s]+)/i.exec(output);
	if (grails?.[1]) {
		return normalizeBrowserUrl(grails[1]);
	}
	const spring = /Started \S+ in \d+(?:\.\d+)? seconds/i.test(output)
		? /Tomcat started on port\(s\): (\d+)/i.exec(output)
		: null;
	if (spring?.[1]) {
		return `http://localhost:${spring[1]}`;
	}
	const netty = /Netty started on port(?:\(s\))?: (\d+)/i.exec(output);
	if (netty?.[1]) {
		return `http://localhost:${netty[1]}`;
	}
	return undefined;
}

export function normalizeBrowserUrl(raw: string): string {
	const trimmed = raw.trim().replace(/[)\]},.;]+$/, '');
	try {
		const parsed = new URL(trimmed);
		return parsed.toString().replace(/\/$/, '') || trimmed;
	} catch {
		return trimmed;
	}
}

export function resolveAppServerUrl(output: string, configured?: string): string | undefined {
	const fromConfig = configured?.trim();
	if (fromConfig) {
		return normalizeBrowserUrl(fromConfig);
	}
	return extractAppReadyUrl(output);
}

export function readGradleDebugStatus(output: string): GradleDebugStatus {
	if (/BUILD FAILED/i.test(output) || /FAILURE: Build failed/i.test(output)) {
		return { phase: 'failed', message: 'Gradle build failed' };
	}
	if (isAppRunning(output)) {
		const url = extractAppReadyUrl(output);
		return {
			phase: 'running',
			message: url ? `Application ready at ${url}` : 'Application is running'
		};
	}
	if (isJdwpListening(output)) {
		return { phase: 'jdwp', message: 'Debug port open, attaching…' };
	}

	const task = lastGradleTask(output);
	if (task && isBootOrRunTask(task)) {
		return { phase: 'compiled', message: 'Build finished, starting app…', task };
	}
	if (task) {
		return {
			phase: isCompileLikeTask(task) ? 'compiling' : 'starting',
			message: `Gradle ${task}`,
			task
		};
	}
	return { phase: 'starting', message: 'Starting Gradle…' };
}

export function lastGradleTask(output: string): string | undefined {
	const re = /> Task (:[^\s]+)/g;
	let last: string | undefined;
	let match: RegExpExecArray | null;
	while ((match = re.exec(output)) !== null) {
		last = match[1];
	}
	return last;
}

function isBootOrRunTask(task: string): boolean {
	return /:(?:[\w.-]+:)*(?:bootRun|run)$/i.test(task);
}

function isCompileLikeTask(task: string): boolean {
	return /compile|classes|jar|war|processResources/i.test(task);
}

export function buildInitialDebugConfigurations(): Array<GroovyDebugInput & { type: 'groovy'; name: string; request: string }> {
	return [
		{
			type: 'groovy',
			request: 'launch',
			name: 'Groovy: Launch Grails',
			port: DEFAULT_DEBUG_PORT
		},
		{
			type: 'groovy',
			request: 'attach',
			name: 'Groovy: Attach',
			hostName: 'localhost',
			port: DEFAULT_DEBUG_PORT
		}
	];
}

export function dynamicDebugConfigurations<T extends { type?: string }>(
	generated: T[],
	existingLaunchConfigs: Array<{ type?: string }> | undefined
): T[] {
	if ((existingLaunchConfigs || []).some(config => config.type === 'groovy')) {
		return [];
	}
	return generated;
}

function detectProjectKind(
	workspaceRoot: string,
	modules: GrailsModule[],
	projectRoot: string
): GroovyDebugProjectKind {
	if (fs.existsSync(path.join(workspaceRoot, 'grails-app')) || modules.some(module => fs.existsSync(module.grailsAppPath))) {
		return 'grails';
	}

	const buildText = readBuildScripts(projectRoot) + readBuildScripts(workspaceRoot);
	if (/\bmicronaut\b/i.test(buildText)) {
		return 'micronaut';
	}
	if (
		findGradleWrapper(workspaceRoot)
		|| fs.existsSync(path.join(projectRoot, 'build.gradle'))
		|| fs.existsSync(path.join(projectRoot, 'build.gradle.kts'))
	) {
		return 'gradle';
	}
	return 'unknown';
}

function pickBootRunModule(modules: GrailsModule[]): GrailsModule | undefined {
	for (const name of PREFERRED_BOOT_MODULES) {
		const match = modules.find(module => module.name === name && fs.existsSync(module.grailsAppPath));
		if (match) {
			return match;
		}
	}
	return modules.find(module => fs.existsSync(module.grailsAppPath));
}

function readBuildScripts(root: string): string {
	let text = '';
	for (const name of ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']) {
		const full = path.join(root, name);
		if (!fs.existsSync(full)) {
			continue;
		}
		try {
			text += `\n${fs.readFileSync(full, 'utf8')}`;
		} catch {
			// ignore unreadable build files
		}
	}
	return text;
}

function pushUnique(items: string[], value: string): void {
	const normalized = path.normalize(value);
	if (!items.includes(normalized)) {
		items.push(normalized);
	}
}

function uniquePaths(items: string[]): string[] {
	const result: string[] = [];
	for (const item of items) {
		pushUnique(result, item);
	}
	return result;
}

/** Gradle/Grails copies resources under `bin/default` (and sometimes `bin/main`); JDT may open those instead of `grails-app`. */
export function remapGradleBuildOutputToSource(filePath: string): string {
	if (!filePath || !/[/\\]bin([/\\]default|[/\\]main)([/\\])/i.test(filePath)) {
		return filePath;
	}
	const candidate = filePath.replace(/([/\\])bin([/\\])(?:default|main)([/\\])/g, '$1');
	if (candidate === filePath) {
		return filePath;
	}
	try {
		return fs.existsSync(candidate) ? candidate : filePath;
	} catch {
		return filePath;
	}
}
