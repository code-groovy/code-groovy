import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';

export interface ClasspathResolution {
	/** JARs kept for indexing, capped and ranked. */
	jars: string[];
	/** Every resolved JAR. Compiler diagnostics need the full list, not the index cap. */
	allJars: string[];
	tool: 'gradle' | 'maven' | 'workspace' | 'none';
	warning?: string;
}

const GRADLE_INIT_SCRIPT = `
def codeGroovyPrintClasspath = { project ->
  def configs = ['compileClasspath', 'runtimeClasspath', 'compile', 'runtime']
  def found = false
  configs.each { name ->
    if (found) { return }
    def cfg = project.configurations.findByName(name)
    if (cfg == null) { return }
    try {
      cfg.files.each { file ->
        if (file.name.endsWith('.jar')) {
          println "CODE_GROOVY_CP:" + file.absolutePath
        }
      }
      found = true
    } catch (Throwable ignored) { }
  }
}

allprojects { project ->
  afterEvaluate {
    codeGroovyPrintClasspath(project)
    if (project.tasks.findByName('printCodeGroovyClasspath') == null) {
      project.tasks.create('printCodeGroovyClasspath') {
        doLast { codeGroovyPrintClasspath(project) }
      }
    }
  }
}
`;

export function parseClasspathLines(output: string): string[] {
	const jars: string[] = [];
	for (const line of output.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		if (trimmed.startsWith('CODE_GROOVY_CP:')) {
			jars.push(trimmed.slice('CODE_GROOVY_CP:'.length));
			continue;
		}
		if (trimmed.includes('.jar') && (trimmed.includes(':') || trimmed.includes(';'))) {
			const delimiter = trimmed.includes(path.delimiter) ? path.delimiter : (trimmed.includes(';') ? ';' : ':');
			for (const part of trimmed.split(delimiter)) {
				if (part.endsWith('.jar')) {
					jars.push(part);
				}
			}
			continue;
		}
		if (trimmed.endsWith('.jar')) {
			jars.push(trimmed);
		}
	}
	return unique(jars);
}

export function hashWorkspaceBuildFiles(workspaceRoot: string): string {
	const hash = createHash('sha256');
	for (const file of collectBuildInputFiles(workspaceRoot)) {
		hash.update(file);
		try {
			hash.update(fs.readFileSync(file));
		} catch {
			// skip unreadable
		}
	}
	return hash.digest('hex');
}

export function prioritizeJars(jars: string[], limit = 300): string[] {
	const scored = jars.map(jar => {
		const base = path.basename(jar).toLowerCase();
		let score = 0;
		if (base.includes('grails')) score += 100;
		if (base.includes('spring-security')) score += 95;
		if (base.includes('groovy')) score += 80;
		if (base.includes('converters')) score += 75;
		if (base.includes('encoder')) score += 70;
		if (base.includes('web-common')) score += 70;
		if (base.includes('validation')) score += 40;
		if (base.includes('spring')) score += 20;
		return { jar, score };
	});
	scored.sort((a, b) => b.score - a.score || a.jar.localeCompare(b.jar));
	return scored.slice(0, limit).map(s => s.jar);
}

export async function resolveProjectClasspath(
	workspaceRoot: string,
	runCommand: typeof runProcess = runProcess
): Promise<ClasspathResolution> {
	const workspaceJars = collectWorkspaceJars(workspaceRoot);
	const gradleProjectRoot = resolveGradleProjectRoot(workspaceRoot);
	const gradlew = findGradlew(workspaceRoot);
	if (gradlew) {
		try {
			const jars = await resolveGradleClasspath(gradleProjectRoot, gradlew, runCommand);
			return resolution(uniqueExisting([...jars, ...workspaceJars]), 'gradle');
		} catch (error) {
			return resolution(workspaceJars, workspaceJars.length ? 'workspace' : 'none', `Gradle classpath failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	const pom = path.join(workspaceRoot, 'pom.xml');
	if (fs.existsSync(pom)) {
		try {
			const jars = await resolveMavenClasspath(workspaceRoot, runCommand);
			return resolution(uniqueExisting([...jars, ...workspaceJars]), 'maven');
		} catch (error) {
			return resolution(workspaceJars, workspaceJars.length ? 'workspace' : 'none', `Maven classpath failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	if (workspaceJars.length) {
		return resolution(workspaceJars, 'workspace');
	}

	return resolution([], 'none', 'No Gradle/Maven project or workspace JARs found; auto-import limited to source.');
}

function resolution(
	jars: string[],
	tool: ClasspathResolution['tool'],
	warning?: string
): ClasspathResolution {
	return {
		jars: prioritizeJars(jars),
		allJars: jars,
		tool,
		warning
	};
}

async function resolveGradleClasspath(
	workspaceRoot: string,
	gradlew: string,
	runCommand: typeof runProcess
): Promise<string[]> {
	const initFile = path.join(os.tmpdir(), `code-groovy-classpath-${Date.now()}.gradle`);
	fs.writeFileSync(initFile, GRADLE_INIT_SCRIPT, 'utf8');
	try {
		const output = await runCommand(gradlew, ['-q', '-I', initFile, 'printCodeGroovyClasspath'], {
			cwd: workspaceRoot,
			timeoutMs: 120_000
		});
		const jars = parseClasspathLines(output);
		if (jars.length === 0) {
			const output2 = await runCommand(gradlew, ['-q', '-I', initFile, 'help'], {
				cwd: workspaceRoot,
				timeoutMs: 120_000
			});
			return parseClasspathLines(output2);
		}
		return jars;
	} finally {
		try {
			fs.unlinkSync(initFile);
		} catch {
			// ignore
		}
	}
}

async function resolveMavenClasspath(
	workspaceRoot: string,
	runCommand: typeof runProcess
): Promise<string[]> {
	const outFile = path.join(os.tmpdir(), `code-groovy-cp-${Date.now()}.txt`);
	try {
		await runCommand(
			'mvn',
			['-q', 'dependency:build-classpath', `-Dmdep.outputFile=${outFile}`],
			{ cwd: workspaceRoot, timeoutMs: 180_000 }
		);
		const content = fs.readFileSync(outFile, 'utf8');
		return parseClasspathLines(content.includes(path.delimiter) ? content : content.split(/\s+/).join(path.delimiter));
	} finally {
		try {
			fs.unlinkSync(outFile);
		} catch {
			// ignore
		}
	}
}

function collectWorkspaceJars(workspaceRoot: string): string[] {
	const jars: string[] = [];
	const candidates = [
		path.join(workspaceRoot, 'lib'),
		path.join(workspaceRoot, 'build', 'libs'),
		path.join(workspaceRoot, 'target')
	];
	for (const dir of candidates) {
		walkJars(dir, jars, 3);
	}
	return jars;
}

function walkJars(dir: string, out: string[], depth: number): void {
	if (depth < 0 || !fs.existsSync(dir)) {
		return;
	}
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			walkJars(full, out, depth - 1);
		} else if (entry.isFile() && entry.name.endsWith('.jar')) {
			out.push(full);
		}
	}
}

function findGradlew(workspaceRoot: string): string | undefined {
	let current = workspaceRoot;
	for (let depth = 0; depth < 6; depth++) {
		const win = path.join(current, 'gradlew.bat');
		const unix = path.join(current, 'gradlew');
		if (process.platform === 'win32' && fs.existsSync(win)) {
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

export function resolveGradleProjectRoot(workspacePath: string): string {
	const gradlew = findGradlew(workspacePath);
	return gradlew ? path.dirname(gradlew) : workspacePath;
}

function unique(jars: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const jar of jars) {
		if (!jar || seen.has(jar)) {
			continue;
		}
		seen.add(jar);
		result.push(jar);
	}
	return result;
}

function uniqueExisting(jars: string[]): string[] {
	return unique(jars).filter(jar => {
		try {
			return fs.existsSync(jar);
		} catch {
			return false;
		}
	});
}

function collectBuildInputFiles(workspaceRoot: string): string[] {
	const names = [
		'build.gradle',
		'build.gradle.kts',
		'settings.gradle',
		'settings.gradle.kts',
		'gradle.lockfile',
		'pom.xml'
	];
	const files: string[] = [];
	for (const name of names) {
		const full = path.join(workspaceRoot, name);
		if (fs.existsSync(full)) {
			files.push(full);
		}
	}

	try {
		for (const entry of fs.readdirSync(workspaceRoot, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name.startsWith('.')) {
				continue;
			}
			for (const name of ['build.gradle', 'build.gradle.kts', 'pom.xml']) {
				const full = path.join(workspaceRoot, entry.name, name);
				if (fs.existsSync(full)) {
					files.push(full);
				}
			}
		}
	} catch {
		// ignore
	}

	return files.sort();
}

export function runProcess(
	command: string,
	args: string[],
	options: { cwd: string; timeoutMs: number }
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: process.env,
			shell: process.platform === 'win32'
		});
		let stdout = '';
		let stderr = '';
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`Timed out after ${options.timeoutMs}ms`));
		}, options.timeoutMs);

		child.stdout.on('data', (chunk: Buffer) => {
			stdout += chunk.toString('utf8');
		});
		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf8');
		});
		child.on('error', err => {
			clearTimeout(timer);
			reject(err);
		});
		child.on('close', code => {
			clearTimeout(timer);
			if (code === 0) {
				resolve(stdout + '\n' + stderr);
			} else {
				reject(new Error(stderr || stdout || `Exit code ${code}`));
			}
		});
	});
}
