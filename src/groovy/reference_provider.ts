import * as vscode from 'vscode';
import { CallSiteIndexStore } from './call_site_index_store';
import { findWordMatches } from './text_scan_logic';
import { propertyScanner, toVscodeLocation, wordScanner } from './usage_locations';
import { collectUsageLocations, declarationLocations, findReferenceTarget, isDeclarationAt, resolveUsages, UsageHierarchy } from './usage_lookup_logic';

export class ReferenceProvider implements vscode.ReferenceProvider {
	constructor(
		private readonly callSiteIndex: CallSiteIndexStore,
		private readonly hierarchy: UsageHierarchy
	) {}

	async provideReferences(
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.ReferenceContext,
		token: vscode.CancellationToken
	): Promise<vscode.Location[] | undefined> {
		const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
		if (!wordRange) {
			return undefined;
		}

		const word = document.getText(wordRange);
		const documentText = document.getText();
		const line = wordRange.start.line;
		const target = findReferenceTarget(documentText, document.uri.fsPath, line, wordRange.start.character, word, this.hierarchy);
		if (!target) {
			return findWordMatches(documentText, word)
				.map(match => new vscode.Location(document.uri, new vscode.Range(match.line, match.column, match.line, match.column + word.length)));
		}
		const isDeclaration = isDeclarationAt(documentText, document.uri.fsPath, line, word, wordRange.start.character);
		const resolution = resolveUsages(target, this.callSiteIndex, 'references', this.hierarchy);
		const declaration = isDeclaration ? { sourcePath: document.uri.fsPath, line, column: wordRange.start.character } : undefined;
		const usages = (await collectUsageLocations(target, resolution, 'references', word, wordScanner(token), declaration, propertyScanner(token))).map(toVscodeLocation);
		if (!context.includeDeclaration) {
			return usages;
		}
		if (isDeclaration) {
			return [new vscode.Location(document.uri, wordRange), ...usages];
		}
		return [...declarationLocations(target, word, this.hierarchy).map(toVscodeLocation), ...usages];
	}
}
