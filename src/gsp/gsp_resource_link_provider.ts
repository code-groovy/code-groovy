import * as vscode from 'vscode';
import { ClassIndex } from '../groovy/class_index';
import { resolveGradleProjectRoot } from '../groovy/classpath_resolver';
import { LinkArgHit, resolveControllerActionDefinitions } from './controller_action_navigation_logic';
import { listEmbeddedLinkArgs } from './gsp_definition_logic';
import {
	findOpenTagBefore,
	listResourceAttributeValues,
	resolveGspResourcePath
} from './gsp_resource_path_logic';

/**
 * Underlines the full template/src/url attribute value (not just one path segment)
 * and opens the resolved view/asset on Ctrl+click.
 */
export class GspResourceLinkProvider implements vscode.DocumentLinkProvider {
	constructor(private readonly classIndex: ClassIndex) {}

	provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const workspaceRoot = workspaceFolder
			? resolveGradleProjectRoot(workspaceFolder)
			: undefined;
		if (!workspaceRoot) {
			return [];
		}

		const links: vscode.DocumentLink[] = [];
		for (let line = 0; line < document.lineCount; line++) {
			const text = document.lineAt(line).text;
			for (const hit of listResourceAttributeValues(text)) {
				if (hit.value.includes('${')) {
					continue;
				}
				const openTag = findOpenTagBefore(text, hit.valueStart);
				const targetPath = resolveGspResourcePath({
					attrName: hit.name,
					attrValue: hit.value,
					tag: openTag,
					workspaceRoot
				});
				if (!targetPath) {
					continue;
				}
				const range = new vscode.Range(
					new vscode.Position(line, hit.valueStart),
					new vscode.Position(line, hit.valueEnd)
				);
				const link = new vscode.DocumentLink(range, vscode.Uri.file(targetPath));
				link.tooltip = `Open ${hit.value}`;
				links.push(link);
			}
		}
		return [...links, ...this.controllerActionLinks(document, workspaceRoot)]
			.sort((a, b) => a.range.start.compareTo(b.range.start));
	}

	resolveDocumentLink(link: vscode.DocumentLink): vscode.DocumentLink | undefined {
		if (!(link instanceof ControllerActionLink)) {
			return link;
		}
		const [target] = resolveControllerActionDefinitions(link.hit, {
			sourcePath: link.sourcePath,
			workspaceRoot: link.workspaceRoot,
			findEntries: className => this.classIndex.getArtifactIndex().findAllByClassName(className)
		});
		if (!target) {
			return undefined;
		}
		link.target = vscode.Uri.file(target.uri).with({ fragment: `L${target.line + 1},${target.column + 1}` });
		return link;
	}

	private controllerActionLinks(document: vscode.TextDocument, workspaceRoot: string): vscode.DocumentLink[] {
		return listEmbeddedLinkArgs(document.getText()).map(({ start, end, hit }) => new ControllerActionLink(
			new vscode.Range(document.positionAt(start), document.positionAt(end)),
			hit,
			document.uri.fsPath,
			workspaceRoot
		));
	}
}

class ControllerActionLink extends vscode.DocumentLink {
	constructor(
		range: vscode.Range,
		readonly hit: LinkArgHit,
		readonly sourcePath: string,
		readonly workspaceRoot: string
	) {
		super(range);
		this.tooltip = `Open ${hit.arg.name} ${hit.arg.value}`;
	}
}
