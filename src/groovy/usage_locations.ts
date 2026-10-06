import * as vscode from 'vscode';
import * as fs from 'fs';
import { discoverSourceFiles } from './source_file_discovery';
import { findWordMatches } from './text_scan_logic';
import { TextScan, UsageLocation } from './usage_lookup_logic';

const CONCURRENCY = 64;

export function wordScanner(token?: vscode.CancellationToken): (word: string, scan: TextScan) => Promise<UsageLocation[]> {
	return (word, scan) => findWordOccurrences(
		word,
		scan.receiverFieldName,
		token,
		scan.scope === 'files' ? scan.files : undefined
	);
}

export async function findWordOccurrences(
	word: string,
	receiverFieldName?: string,
	token?: vscode.CancellationToken,
	files?: string[]
): Promise<UsageLocation[]> {
	if (!word || word.length < 2) {
		return [];
	}

	const filePaths = files ?? (await discoverSourceFiles()).filePaths;
	const results: UsageLocation[] = [];

	let index = 0;
	const worker = async (): Promise<void> => {
		while (index < filePaths.length) {
			if (token?.isCancellationRequested) {
				return;
			}
			const current = filePaths[index++];
			let text: string;
			try {
				text = await fs.promises.readFile(current, 'utf8');
			} catch {
				continue;
			}
			for (const match of findWordMatches(text, word, receiverFieldName)) {
				results.push({ sourcePath: current, line: match.line, column: match.column, length: word.length });
			}
		}
	};

	const workerCount = Math.min(CONCURRENCY, filePaths.length) || 1;
	await Promise.all(Array.from({ length: workerCount }, () => worker()));

	return results;
}

export function toVscodeLocation(location: UsageLocation): vscode.Location {
	return new vscode.Location(
		vscode.Uri.file(location.sourcePath),
		new vscode.Range(location.line, location.column, location.line, location.column + location.length)
	);
}
