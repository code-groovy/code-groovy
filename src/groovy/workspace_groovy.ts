import * as vscode from 'vscode';

const GROOVY_GLOB = '**/*.{groovy,gsp}';
const GROOVY_EXCLUDE = '**/{node_modules,.git,build,target,out}/**';

export async function workspaceContainsGroovy(): Promise<boolean> {
	const files = await vscode.workspace.findFiles(GROOVY_GLOB, GROOVY_EXCLUDE, 1);
	return files.length > 0;
}
