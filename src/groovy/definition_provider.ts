import * as vscode from 'vscode';
import { ClassIndexStore } from './class_index_store';
import { GrailsArtifactIndex } from './grails_artifact_index';
import { resolveDefinitions } from './definition_resolver';
import { resolveGradleProjectRoot } from './classpath_resolver';
import { resolveGspDefinitions } from '../gsp/gsp_definition_logic';
import { resolveGroovyTagLibDefinitions } from '../gsp/groovy_taglib_navigation_logic';
import { ProjectTagLibTag } from '../gsp/taglib_parser';
import { propertyScanner, toVscodeLocation, wordScanner } from './usage_locations';
import { CallSiteIndexStore } from './call_site_index_store';
import { collectUsageLocations, excludePosition, findDeclarationTarget, resolveUsages, UsageHierarchy } from './usage_lookup_logic';
import { isInsideComment, isInsideDocLink } from './text_scan_logic';

export class DefinitionProvider implements vscode.DefinitionProvider {
	constructor(
		private readonly classStore: ClassIndexStore,
		private readonly artifactIndex: GrailsArtifactIndex,
		private readonly getClasspathJars: () => string[],
		private readonly callSiteIndex: CallSiteIndexStore,
		private readonly hierarchy: UsageHierarchy,
		private readonly getGspTags: () => ProjectTagLibTag[] = () => []
	) {}

	async provideDefinition(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken
	): Promise<vscode.Location | vscode.Location[] | undefined> {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const workspaceRoot = workspaceFolder ? resolveGradleProjectRoot(workspaceFolder) : undefined;

		// Embedded `${...}` in GSP is routed to the Groovy language feature by VS Code.
		// Handle .gsp here so `demoUI.icon(...)` resolves like `<demoUI:icon>`.
		if (isGspDocument(document)) {
			const gspTargets = resolveGspDefinitions({
				documentText: document.getText(),
				line: position.line,
				character: position.character,
				sourcePath: document.uri.fsPath,
				workspaceRoot,
				classpathJars: this.getClasspathJars(),
				tags: this.getGspTags(),
				classStore: this.classStore,
				artifactIndex: this.artifactIndex
			});
			return toLocations(gspTargets);
		}

		if (isInsideComment(document.getText(), document.offsetAt(position))
			&& !isInsideDocLink(document.lineAt(position.line).text, position.character)) {
			return undefined;
		}

		const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
		const tagLibTargets = resolveGroovyTagLibDefinitions({
			documentText: document.getText(),
			line: position.line,
			character: position.character,
			workspaceRoot,
			tags: this.getGspTags()
		});
		if (tagLibTargets.length > 0) {
			return toLocations(tagLibTargets);
		}

		if (!wordRange) {
			return undefined;
		}

		const word = document.getText(wordRange);
		const wordPosition = { sourcePath: document.uri.fsPath, line: wordRange.start.line, column: wordRange.start.character };
		const target = findDeclarationTarget(document.getText(), document.uri.fsPath, wordPosition.line, word, wordPosition.column);
		if (!target) {
			const targets = resolveDefinitions({
				documentText: document.getText(),
				line: position.line,
				character: position.character,
				word,
				wordStart: wordRange.start.character,
				sourcePath: document.uri.fsPath,
				workspaceRoot,
				classpathJars: this.getClasspathJars(),
				classStore: this.classStore,
				artifactIndex: this.artifactIndex
			});
			return toLocations(excludePosition(targets, wordPosition));
		}

		const resolution = resolveUsages(target, this.callSiteIndex, 'navigate', this.hierarchy);
		const usages = (await collectUsageLocations(target, resolution, 'navigate', word, wordScanner(token), wordPosition, propertyScanner(token))).map(toVscodeLocation);
		if (usages.length === 0) {
			return undefined;
		}
		return usages.length === 1 ? usages[0] : usages;
	}
}

function isGspDocument(document: vscode.TextDocument): boolean {
	return document.languageId === 'gsp' || /\.gsp$/i.test(document.uri.fsPath);
}

function toLocations(
	targets: Array<{ uri: string; line: number; column: number }>
): vscode.Location | vscode.Location[] | undefined {
	if (targets.length === 0) {
		return undefined;
	}
	const locations = targets.map(target => new vscode.Location(
		target.uri.includes('jar:') ? vscode.Uri.parse(target.uri) : vscode.Uri.file(target.uri),
		new vscode.Position(target.line, target.column)
	));
	return locations.length === 1 ? locations[0] : locations;
}
