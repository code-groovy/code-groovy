import * as fs from 'fs';
import { resolveReceiverType } from './call_site_extractor';
import { simpleNameFromFqn } from './class_index_store';
import { GrailsArtifactIndex } from './grails_artifact_index';
import { listMethodsInClassHierarchy, ListedMethod } from './method_navigation_logic';
import { candidateClassNamesForReceiver } from './service_bean';
import { splitLines } from './text_scan_logic';

export interface MethodCompletion {
	name: string;
	className: string;
	detail: string;
}

export interface MethodCompletionContext {
	linePrefix: string;
	documentText: string;
	artifactIndex: GrailsArtifactIndex;
	line?: number;
	sourcePath?: string;
	readFile?: (filePath: string) => string | undefined;
}

const MEMBER_ACCESS_RE = /([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)?$/;

export function parseMemberAccess(linePrefix: string): { receiver: string; prefix: string } | undefined {
	const match = linePrefix.match(MEMBER_ACCESS_RE);
	if (!match) {
		return undefined;
	}
	return {
		receiver: match[1],
		prefix: match[2] ?? ''
	};
}

export function resolveReceiverClassNames(documentText: string, receiver: string, line?: number, sourcePath?: string): string[] {
	const names = candidateClassNamesForReceiver(receiver);
	const typed = resolveReceiverType(documentText, line ?? splitLines(documentText).length - 1, receiver, sourcePath);
	if (typed) {
		names.unshift(simpleNameFromFqn(typed));
	}
	return [...new Set(names)];
}

export function resolveMethodCompletions(context: MethodCompletionContext): MethodCompletion[] {
	const access = parseMemberAccess(context.linePrefix);
	if (!access) {
		return [];
	}

	const readFile = context.readFile ?? ((filePath: string) => {
		try {
			return fs.readFileSync(filePath, 'utf8');
		} catch {
			return undefined;
		}
	});

	const findEntries = (className: string) => context.artifactIndex.findAllByClassName(className);
	const prefix = access.prefix.toLowerCase();
	const seen = new Set<string>();
	const completions: MethodCompletion[] = [];

	for (const className of resolveReceiverClassNames(context.documentText, access.receiver, context.line, context.sourcePath)) {
		const methods = listMethodsInClassHierarchy(readFile, findEntries, className, new Set(), 0, context.documentText);
		for (const method of methods) {
			if (prefix && !method.name.toLowerCase().startsWith(prefix)) {
				continue;
			}
			if (seen.has(method.name)) {
				continue;
			}
			seen.add(method.name);
			completions.push(toCompletion(method, className));
		}
		if (completions.length > 0) {
			break;
		}
	}

	return completions;
}

function toCompletion(method: ListedMethod, fallbackClass: string): MethodCompletion {
	const className = method.className || fallbackClass;
	return {
		name: method.name,
		className,
		detail: `${className}.${method.name}`
	};
}
