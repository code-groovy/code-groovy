import { DefinitionTarget, resolveDefinitions } from '../groovy/definition_resolver';
import { ClassIndexStore } from '../groovy/class_index_store';
import { GrailsArtifactIndex } from '../groovy/grails_artifact_index';
import {
	findAttributeValueAtPosition,
	findOpenTagBefore,
	resolveGspResourcePath
} from './gsp_resource_path_logic';
import { ProjectTagLibTag, tagMatchesReceiver } from './taglib_parser';
import {
	ControllerActionContext,
	findGroovyLinkArgAt,
	findGspTagLinkArgAt,
	LinkArgHit,
	resolveControllerActionDefinitions
} from './controller_action_navigation_logic';

export interface GspDefinitionContext {
	documentText: string;
	line: number;
	character: number;
	sourcePath: string;
	workspaceRoot?: string;
	classpathJars?: string[];
	tags: ProjectTagLibTag[];
	classStore: ClassIndexStore;
	artifactIndex: GrailsArtifactIndex;
}

export interface EmbeddedLinkArg {
	start: number;
	end: number;
	hit: LinkArgHit;
}

const EMBEDDED_LINK_KEY_RE = /\b(?:controller|action|view)\s*:\s*(["'])/g;
const TAG_AT_RE = /<\/?([A-Za-z_]\w*):([A-Za-z_]\w*)/g;
const TAGLIB_CALL_RE = /\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)\b/g;
/** Built-in Grails/Asset namespaces that are TagLib calls, not bean.method. */
const CORE_TAGLIB_NAMESPACES = new Set(['g', 'asset']);

export function findTagAtPosition(
	lineText: string,
	character: number
): { namespace: string; method: string } | undefined {
	TAG_AT_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = TAG_AT_RE.exec(lineText)) !== null) {
		const start = match.index;
		const end = start + match[0].length;
		if (character >= start && character < end) {
			return { namespace: match[1], method: match[2] };
		}
	}
	return undefined;
}

/** Matches Grails TagLib calls like `g.createLink` / `demoUI.accountLink`. */
export function findTagLibCallAtPosition(
	text: string,
	offset: number
): { namespace: string; method: string } | undefined {
	TAGLIB_CALL_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = TAGLIB_CALL_RE.exec(text)) !== null) {
		const start = match.index;
		const end = start + match[0].length;
		if (offset >= start && offset < end) {
			return { namespace: match[1], method: match[2] };
		}
	}
	return undefined;
}

function resolveProjectTag(
	tags: ProjectTagLibTag[],
	namespace: string,
	method: string
): DefinitionTarget[] {
	const projectTag = tags.find(item => tagMatchesReceiver(item, namespace) && item.method === method);
	if (!projectTag) {
		return [];
	}
	return [{
		uri: projectTag.sourcePath,
		line: projectTag.methodLine,
		column: projectTag.methodColumn,
		label: projectTag.name
	}];
}

function isTagLibNamespace(namespace: string, tags: ProjectTagLibTag[]): boolean {
	if (CORE_TAGLIB_NAMESPACES.has(namespace)) {
		return true;
	}
	return tags.some(tag => tagMatchesReceiver(tag, namespace));
}

export function findEmbeddedGroovyAtOffset(
	documentText: string,
	offset: number
): { text: string; localOffset: number } | undefined {
	const dollar = findRegionContaining(documentText, offset, '${', '}');
	if (dollar) {
		return dollar;
	}
	return findRegionContaining(documentText, offset, '<%', '%>');
}

function findRegionContaining(
	documentText: string,
	offset: number,
	open: string,
	close: string
): { text: string; localOffset: number } | undefined {
	let searchFrom = 0;
	while (searchFrom < documentText.length) {
		const start = documentText.indexOf(open, searchFrom);
		if (start === -1 || start > offset) {
			return undefined;
		}
		const contentStart = start + open.length;
		const end = documentText.indexOf(close, contentStart);
		if (end === -1) {
			return undefined;
		}
		if (offset >= contentStart && offset < end) {
			return {
				text: documentText.slice(contentStart, end),
				localOffset: offset - contentStart
			};
		}
		searchFrom = end + close.length;
	}
	return undefined;
}

export function listEmbeddedLinkArgs(documentText: string): EmbeddedLinkArg[] {
	const args: EmbeddedLinkArg[] = [];
	EMBEDDED_LINK_KEY_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = EMBEDDED_LINK_KEY_RE.exec(documentText)) !== null) {
		const valueOffset = match.index + match[0].length;
		const embedded = findEmbeddedGroovyAtOffset(documentText, valueOffset);
		const hit = embedded ? findGroovyLinkArgAt(embedded.text, embedded.localOffset) : undefined;
		if (embedded && hit) {
			const contentStart = valueOffset - embedded.localOffset;
			args.push({ start: contentStart + hit.arg.valueStart, end: contentStart + hit.arg.valueEnd, hit });
		}
	}
	return args;
}

export function resolveGspDefinitions(context: GspDefinitionContext): DefinitionTarget[] {
	const lines = context.documentText.split('\n');
	const lineText = lines[context.line] ?? '';

	// template="/..." / src="..." on g:render / asset:* → open the view or asset file
	const attr = findAttributeValueAtPosition(lineText, context.character);
	if (attr && context.workspaceRoot) {
		const openTag = findOpenTagBefore(lineText, context.character);
		const resourcePath = resolveGspResourcePath({
			attrName: attr.name,
			attrValue: attr.value,
			tag: openTag,
			workspaceRoot: context.workspaceRoot
		});
		if (resourcePath) {
			return [{ uri: resourcePath, line: 0, column: 0, label: attr.value }];
		}
	}

	const offset = offsetAt(lines, context.line, context.character);
	const tagLink = findGspTagLinkArgAt(context.documentText, offset);
	if (tagLink) {
		return resolveControllerActionDefinitions(tagLink, controllerActionContext(context));
	}

	const tag = findTagAtPosition(lineText, context.character);
	if (tag) {
		// XML-style <g:createLink> / <demoUI:x>. Core g: tags with no project TagLib → no target
		// (do not fall through — avoids bogus resolutions / HTML "open file" fallthrough).
		return resolveProjectTag(context.tags, tag.namespace, tag.method);
	}

	const embedded = findEmbeddedGroovyAtOffset(context.documentText, offset);
	if (!embedded) {
		return [];
	}

	const embeddedLink = findGroovyLinkArgAt(embedded.text, embedded.localOffset);
	if (embeddedLink) {
		return resolveControllerActionDefinitions(embeddedLink, controllerActionContext(context));
	}

	const tagLibCall = findTagLibCallAtPosition(embedded.text, embedded.localOffset);
	if (tagLibCall && isTagLibNamespace(tagLibCall.namespace, context.tags)) {
		const fromProject = resolveProjectTag(context.tags, tagLibCall.namespace, tagLibCall.method);
		if (fromProject.length > 0) {
			return fromProject;
		}
		// e.g. g.createLink — core TagLib, not in the workspace. Empty (don't resolve `g` as class `G`).
		return [];
	}

	const local = positionAt(embedded.text, embedded.localOffset);
	const wordRange = wordRangeAt(embedded.text, embedded.localOffset);
	if (!wordRange) {
		return [];
	}

	return resolveDefinitions({
		documentText: embedded.text,
		line: local.line,
		character: local.character,
		word: embedded.text.slice(wordRange.start, wordRange.end),
		wordStart: wordRange.start - lineStartOffset(embedded.text, local.line),
		sourcePath: context.sourcePath,
		workspaceRoot: context.workspaceRoot,
		classpathJars: context.classpathJars,
		classStore: context.classStore,
		artifactIndex: context.artifactIndex
	});
}

function controllerActionContext(context: GspDefinitionContext): ControllerActionContext {
	return {
		sourcePath: context.sourcePath,
		workspaceRoot: context.workspaceRoot,
		findEntries: className => context.artifactIndex.findAllByClassName(className)
	};
}

function offsetAt(lines: string[], line: number, character: number): number {
	let offset = 0;
	for (let i = 0; i < line; i++) {
		offset += (lines[i]?.length ?? 0) + 1;
	}
	return offset + character;
}

function positionAt(text: string, offset: number): { line: number; character: number } {
	const clamped = Math.max(0, Math.min(offset, text.length));
	const before = text.slice(0, clamped);
	const parts = before.split('\n');
	return {
		line: parts.length - 1,
		character: parts[parts.length - 1].length
	};
}

function lineStartOffset(text: string, line: number): number {
	if (line <= 0) {
		return 0;
	}
	const parts = text.split('\n');
	let offset = 0;
	for (let i = 0; i < line; i++) {
		offset += (parts[i]?.length ?? 0) + 1;
	}
	return offset;
}

function wordRangeAt(text: string, offset: number): { start: number; end: number } | undefined {
	if (offset < 0 || offset > text.length) {
		return undefined;
	}
	let start = offset;
	let end = offset;
	while (start > 0 && /[A-Za-z0-9_]/.test(text[start - 1])) {
		start -= 1;
	}
	while (end < text.length && /[A-Za-z0-9_]/.test(text[end])) {
		end += 1;
	}
	if (start === end || !/^[A-Za-z_]/.test(text[start])) {
		return undefined;
	}
	return { start, end };
}
