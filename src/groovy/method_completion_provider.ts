import * as vscode from 'vscode';
import { GrailsArtifactIndex } from './grails_artifact_index';
import { resolveMethodCompletions } from './method_completion_logic';

export class MethodCompletionProvider implements vscode.CompletionItemProvider {
	constructor(private readonly artifactIndex: GrailsArtifactIndex) {}

	provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position
	): vscode.CompletionItem[] {
		const linePrefix = document.lineAt(position).text.slice(0, position.character);
		const completions = resolveMethodCompletions({
			linePrefix,
			documentText: document.getText(),
			artifactIndex: this.artifactIndex,
			line: position.line,
			sourcePath: document.uri.fsPath
		});

		return completions.map((completion, index) => {
			const item = new vscode.CompletionItem(completion.name, vscode.CompletionItemKind.Method);
			item.detail = completion.detail;
			item.insertText = completion.name;
			item.filterText = completion.name;
			item.sortText = `0_${String(index).padStart(4, '0')}_${completion.name}`;
			item.commitCharacters = ['('];
			return item;
		});
	}
}
