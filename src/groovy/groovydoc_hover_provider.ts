import * as vscode from 'vscode';
import * as fs from 'fs';
import { ClassIndexStore } from './class_index_store';
import {
	findGroovydocForName,
	findGroovydocNearOffset
} from './groovydoc_logic';

const WORD_RE = /[A-Za-z_]\w*/;

export class GroovydocHoverProvider implements vscode.HoverProvider {
	constructor(private readonly store?: ClassIndexStore) {}

	async provideHover(
		document: vscode.TextDocument,
		position: vscode.Position
	): Promise<vscode.Hover | undefined> {
		const wordRange = document.getWordRangeAtPosition(position, WORD_RE);
		if (!wordRange) {
			return undefined;
		}

		const word = document.getText(wordRange);
		if (vscode.debug.activeDebugSession?.type === 'groovy') {
			return undefined;
		}
		const text = document.getText();
		const offset = document.offsetAt(position);

		const local = findGroovydocForName(text, word) ?? findGroovydocNearOffset(text, offset);

		if (local) {
			return toHover(local, wordRange);
		}

		if (!this.store) {
			return undefined;
		}

		const indexed = this.store.lookup(word).find(t => t.source === 'workspace' && t.sourcePath);
		if (!indexed?.sourcePath) {
			return undefined;
		}

		try {
			const source = await fs.promises.readFile(indexed.sourcePath, 'utf8');
			const fromType = findGroovydocForName(source, word);
			if (fromType) {
				return toHover(fromType, wordRange);
			}
		} catch {
			return undefined;
		}

		return undefined;
	}
}

function toHover(markdown: string, range: vscode.Range): vscode.Hover {
	const md = new vscode.MarkdownString(markdown);
	md.isTrusted = false;
	md.supportHtml = false;
	return new vscode.Hover(md, range);
}
