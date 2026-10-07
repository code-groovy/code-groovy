import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { ClassIndexStore } from '../../groovy/class_index_store';
import { resolveDefinitions } from '../../groovy/definition_resolver';
import { GrailsArtifactIndex } from '../../groovy/grails_artifact_index';
import { resolveJarTypeDefinition } from '../../groovy/sources_jar_resolver';

function createJarWithClassEntry(jarPath: string, fqn: string): void {
	const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-groovy-jar-'));
	const relativeClassPath = `${fqn.replace(/\./g, path.sep)}.class`;
	const classFile = path.join(stagingDir, relativeClassPath);
	fs.mkdirSync(path.dirname(classFile), { recursive: true });
	fs.writeFileSync(classFile, Buffer.from([0xca, 0xfe, 0xba, 0xbe]));
	execSync(`jar cf "${jarPath}" -C "${stagingDir}" .`);
	fs.rmSync(stagingDir, { recursive: true, force: true });
}

function createMonorepoWithJavaSource(
	root: string,
	fqn: string,
	fileName: string
): void {
	const packageName = fqn.slice(0, fqn.lastIndexOf('.'));
	const packagePath = packageName.replace(/\./g, path.sep);
	const sourcePath = path.join(root, 'domain', 'src', 'main', 'groovy', packagePath, fileName);
	fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
	fs.writeFileSync(sourcePath, `package ${packageName}\n\npublic class ${path.basename(fileName, path.extname(fileName))} {}\n`);
}

function findGrailsCoreJar(): string | undefined {
	const home = os.homedir();
	const base = path.join(home, '.gradle/caches/modules-2/files-2.1/org.grails/grails-core');
	if (!fs.existsSync(base)) {
		return undefined;
	}
	for (const version of fs.readdirSync(base)) {
		const versionDir = path.join(base, version);
		for (const hash of fs.readdirSync(versionDir)) {
			const jar = path.join(versionDir, hash, `grails-core-${version}.jar`);
			if (fs.existsSync(jar)) {
				return jar;
			}
		}
	}
	return undefined;
}

function findGrailsWebCommonJar(): string | undefined {
	const home = os.homedir();
	const base = path.join(home, '.gradle/caches/modules-2/files-2.1/org.grails/grails-web-common');
	if (!fs.existsSync(base)) {
		return undefined;
	}
	for (const version of fs.readdirSync(base)) {
		const versionDir = path.join(base, version);
		for (const hash of fs.readdirSync(versionDir)) {
			const jar = path.join(versionDir, hash, `grails-web-common-${version}.jar`);
			if (fs.existsSync(jar)) {
				return jar;
			}
		}
	}
	return undefined;
}

suite('definition_resolver imports from jars', function () {
	this.timeout(15000);

	test('resolves imported ValidationException via classpath JAR scan', function () {
		const grailsCoreJar = findGrailsCoreJar();
		if (!grailsCoreJar) {
			this.skip();
		}

		const documentText = [
			'package com.example.fixture.web',
			'import grails.validation.ValidationException',
			'class WidgetController {',
			'  void demo() { ValidationException ex }',
			'}'
		].join('\n');

		const targets = resolveDefinitions({
			documentText,
			line: 3,
			character: 20,
			word: 'ValidationException',
			wordStart: 20,
			sourcePath: '/tmp/WidgetController.groovy',
			workspaceRoot: '/tmp/grails-app',
			classpathJars: [grailsCoreJar!],
			classStore: new ClassIndexStore(),
			artifactIndex: new GrailsArtifactIndex()
		});

		assert.ok(targets.length > 0);
		assert.ok(targets[0].uri.includes('ValidationException'));
	});

	test('resolves JSONObject from grails-web-common jar', function () {
		const webCommonJar = findGrailsWebCommonJar();
		if (!webCommonJar) {
			this.skip();
		}
		const resolved = resolveJarTypeDefinition(webCommonJar!, 'org.grails.web.json.JSONObject');
		assert.ok(resolved);
		// Prefer -sources.jar (.java) when Gradle has it; fall back to .class otherwise.
		assert.ok(
			resolved!.uri.includes('JSONObject.java') || resolved!.uri.includes('JSONObject.class'),
			`unexpected URI: ${resolved!.uri}`
		);
	});

	test('prefers workspace source over classpath jar class entry for imported type', function () {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-groovy-ws-jar-'));
		const jarPath = path.join(root, 'fixture.jar');
		const fqn = 'com.example.fixture.support.WorkspaceType';
		try {
			fs.writeFileSync(path.join(root, 'settings.gradle'), 'include "domain"\n');
			createMonorepoWithJavaSource(root, fqn, 'WorkspaceType.java');
			createJarWithClassEntry(jarPath, fqn);

			const documentText = [
				'package com.example.fixture.web',
				`import ${fqn}`,
				'class WidgetController {',
				'  void demo() { WorkspaceType type }',
				'}'
			].join('\n');

			const targets = resolveDefinitions({
				documentText,
				line: 3,
				character: 20,
				word: 'WorkspaceType',
				wordStart: 20,
				sourcePath: path.join(root, 'web', 'WidgetController.groovy'),
				workspaceRoot: root,
				classpathJars: [jarPath],
				classStore: new ClassIndexStore(),
				artifactIndex: new GrailsArtifactIndex()
			});

			assert.ok(targets.length > 0);
			assert.ok(targets[0].uri.endsWith('WorkspaceType.java'));
			assert.ok(!targets[0].uri.startsWith('jar:'));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
