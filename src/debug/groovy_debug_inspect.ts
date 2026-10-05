import * as vscode from 'vscode';
import {
	collectInlineValueSpecs,
	findEvaluatableExpression,
	isUsefulEvalResult
} from './groovy_debug_eval_logic';

export function registerGroovyDebugInspection(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.languages.registerHoverProvider('groovy', new GroovyDebugHoverProvider()),
		vscode.languages.registerEvaluatableExpressionProvider('groovy', new GroovyEvaluatableExpressionProvider()),
		vscode.languages.registerInlineValuesProvider('groovy', new GroovyInlineValuesProvider())
	);
}

export function isGroovyDebugSession(session: vscode.DebugSession | undefined = vscode.debug.activeDebugSession): boolean {
	return session?.type === 'groovy';
}

class GroovyDebugHoverProvider implements vscode.HoverProvider {
	async provideHover(
		document: vscode.TextDocument,
		position: vscode.Position
	): Promise<vscode.Hover | undefined> {
		const session = vscode.debug.activeDebugSession;
		if (!isGroovyDebugSession(session) || !session) {
			return undefined;
		}
		const span = findEvaluatableExpression(document.lineAt(position.line).text, position.character);
		if (!span) {
			return undefined;
		}
		try {
			const body = await session.customRequest('evaluate', {
				expression: span.expression,
				frameId: currentFrameId(),
				context: 'hover'
			}) as { result?: string; type?: string } | undefined;
			if (!isUsefulEvalResult(body)) {
				return undefined;
			}
			const md = new vscode.MarkdownString();
			md.appendCodeblock(String(body!.result), 'text');
			if (body?.type) {
				md.appendMarkdown(`\n\n_${escapeMarkdown(body.type)}_`);
			}
			const range = new vscode.Range(position.line, span.start, position.line, span.end);
			return new vscode.Hover(md, range);
		} catch {
			return undefined;
		}
	}
}

class GroovyEvaluatableExpressionProvider implements vscode.EvaluatableExpressionProvider {
	provideEvaluatableExpression(
		document: vscode.TextDocument,
		position: vscode.Position
	): vscode.ProviderResult<vscode.EvaluatableExpression> {
		if (!isGroovyDebugSession()) {
			return undefined;
		}
		const span = findEvaluatableExpression(document.lineAt(position.line).text, position.character);
		if (!span) {
			return undefined;
		}
		const range = new vscode.Range(position.line, span.start, position.line, span.end);
		return new vscode.EvaluatableExpression(range, span.expression);
	}
}

class GroovyInlineValuesProvider implements vscode.InlineValuesProvider {
	provideInlineValues(
		document: vscode.TextDocument,
		viewPort: vscode.Range,
		_context: vscode.InlineValueContext
	): vscode.ProviderResult<vscode.InlineValue[]> {
		if (!isGroovyDebugSession()) {
			return [];
		}
		const stoppedLine = _context.stoppedLocation?.start.line;
		return collectInlineValueSpecs(
			document.getText(),
			viewPort.start.line,
			viewPort.end.line,
			stoppedLine
		).map(spec => {
			const range = new vscode.Range(spec.line, spec.start, spec.line, spec.end);
			return new vscode.InlineValueVariableLookup(range, spec.name, true);
		});
	}
}

function currentFrameId(): number | undefined {
	const item = (vscode.debug as { activeStackItem?: { frameId?: number } }).activeStackItem;
	return typeof item?.frameId === 'number' ? item.frameId : undefined;
}

function escapeMarkdown(value: string): string {
	return value.replace(/[\\`*_{}[\]()#+\-.!]/g, '\\$&');
}
