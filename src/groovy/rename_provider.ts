import * as vscode from 'vscode';
import { isGroovyKeyword } from './groovy_keywords';
import {
	collectLocalRenameEdits,
	isValidIdentifier,
	prepareLocalRename
} from './rename_logic';

export class RenameProvider implements vscode.RenameProvider {
	prepareRename(
		document: vscode.TextDocument,
		position: vscode.Position
	): vscode.ProviderResult<vscode.Range> {
		const offset = document.offsetAt(position);
		const prepared = prepareLocalRename(document.getText(), offset);
		if (!prepared) {
			return Promise.reject(new Error('You cannot rename this element.'));
		}
		return new vscode.Range(
			document.positionAt(prepared.range.start),
			document.positionAt(prepared.range.end)
		);
	}

	provideRenameEdits(
		document: vscode.TextDocument,
		position: vscode.Position,
		newName: string
	): vscode.ProviderResult<vscode.WorkspaceEdit> {
		if (!isValidIdentifier(newName)) {
			return Promise.reject(new Error(`'${newName}' is not a valid Groovy identifier.`));
		}
		if (isGroovyKeyword(newName)) {
			return Promise.reject(new Error(`'${newName}' is a Groovy keyword.`));
		}

		const offset = document.offsetAt(position);
		const prepared = prepareLocalRename(document.getText(), offset);
		if (!prepared) {
			return Promise.reject(new Error('You cannot rename this element.'));
		}

		const oldName = prepared.placeholder;
		const edits = collectLocalRenameEdits(document.getText(), oldName, newName);
		if (edits.length === 0) {
			return new vscode.WorkspaceEdit();
		}

		const workspaceEdit = new vscode.WorkspaceEdit();
		for (const edit of edits) {
			workspaceEdit.replace(
				document.uri,
				new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)),
				newName
			);
		}
		return workspaceEdit;
	}
}
