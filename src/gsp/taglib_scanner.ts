import * as vscode from 'vscode';
import { SOURCE_EXCLUDE_GLOB } from '../groovy/source_exclusion';
import { parseTagLibSource, ProjectTagLibTag } from './taglib_parser';

export type { ProjectTagLibTag } from './taglib_parser';
export { parseTagLibSource, extractAttributes, toHtmlCustomData } from './taglib_parser';

export async function scanWorkspaceTagLibs(
	token?: vscode.CancellationToken
): Promise<ProjectTagLibTag[]> {
	const files = await vscode.workspace.findFiles(
		'**/grails-app/taglib/**/*TagLib.groovy',
		SOURCE_EXCLUDE_GLOB,
		500,
		token
	);

	const tags: ProjectTagLibTag[] = [];
	for (const file of files) {
		if (token?.isCancellationRequested) {
			break;
		}
		try {
			const bytes = await vscode.workspace.fs.readFile(file);
			const text = Buffer.from(bytes).toString('utf8');
			tags.push(...parseTagLibSource(text, file.fsPath));
		} catch {
			// Ignore unreadable files during the spike.
		}
	}

	tags.sort((a, b) => a.name.localeCompare(b.name));
	return tags;
}
