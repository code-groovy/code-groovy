import * as fs from 'fs';
import * as path from 'path';

export interface AttributeValueHit {
	name: string;
	value: string;
	valueStart: number;
	valueEnd: number;
}

export interface OpenTagContext {
	namespace: string;
	method: string;
}

const ATTR_VALUE_RE = /\b([A-Za-z_]\w*)\s*=\s*(["'])([^"']*)\2/g;
const OPEN_TAG_RE = /<([A-Za-z_]\w*):([A-Za-z_]\w*)\b/g;

const RESOURCE_ATTRS = new Set(['template', 'src', 'url', 'file']);

export function findAttributeValueAtPosition(
	lineText: string,
	character: number
): AttributeValueHit | undefined {
	return listResourceAttributeValues(lineText).find(
		hit => character >= hit.valueStart && character <= hit.valueEnd
	);
}

export function listResourceAttributeValues(lineText: string): AttributeValueHit[] {
	const hits: AttributeValueHit[] = [];
	ATTR_VALUE_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = ATTR_VALUE_RE.exec(lineText)) !== null) {
		const name = match[1];
		if (!RESOURCE_ATTRS.has(name)) {
			continue;
		}
		const value = match[3];
		const valueStart = match.index + match[0].indexOf(match[2] + value) + 1; // after opening quote
		const valueEnd = valueStart + value.length;
		hits.push({ name, value, valueStart, valueEnd });
	}
	return hits;
}

/** Nearest open tag to the left of `character` on the same line. */
export function findOpenTagBefore(lineText: string, character: number): OpenTagContext | undefined {
	OPEN_TAG_RE.lastIndex = 0;
	let last: OpenTagContext | undefined;
	let match: RegExpExecArray | null;
	while ((match = OPEN_TAG_RE.exec(lineText)) !== null) {
		if (match.index >= character) {
			break;
		}
		last = { namespace: match[1], method: match[2] };
	}
	return last;
}

export function resolveGspResourcePath(options: {
	attrName: string;
	attrValue: string;
	tag?: OpenTagContext;
	workspaceRoot: string;
}): string | undefined {
	const raw = options.attrValue.trim();
	if (!raw || raw.includes('${')) {
		return undefined;
	}

	const roots = collectGrailsAppRoots(options.workspaceRoot);
	if (roots.length === 0) {
		return undefined;
	}

	const tag = options.tag;
	if (options.attrName === 'template' || (tag?.namespace === 'g' && tag.method === 'render' && options.attrName === 'template')) {
		return resolveRenderTemplate(raw, roots);
	}

	if (tag?.namespace === 'asset' || options.attrName === 'src') {
		return resolveAssetPath(raw, tag?.method, roots);
	}

	if (options.attrName === 'url' || options.attrName === 'file') {
		return resolveAssetPath(raw, tag?.method, roots) ?? firstExisting(roots, raw);
	}

	return undefined;
}

function resolveRenderTemplate(template: string, grailsAppRoots: string[]): string | undefined {
	const normalized = template.replace(/\\/g, '/').replace(/^\/+/, '');
	const parts = normalized.split('/').filter(Boolean);
	if (parts.length === 0) {
		return undefined;
	}

	const fileBase = parts[parts.length - 1].replace(/\.gsp$/i, '');
	const dirParts = parts.slice(0, -1);
	const underscored = fileBase.startsWith('_') ? fileBase : `_${fileBase}`;

	const candidates: string[] = [];
	for (const grailsApp of grailsAppRoots) {
		const views = path.join(grailsApp, 'views', ...dirParts);
		candidates.push(path.join(views, `${underscored}.gsp`));
		candidates.push(path.join(views, `${fileBase}.gsp`));
	}
	return candidates.find(candidate => fs.existsSync(candidate));
}

function resolveAssetPath(
	src: string,
	method: string | undefined,
	grailsAppRoots: string[]
): string | undefined {
	const normalized = src.replace(/\\/g, '/').replace(/^\/+/, '');
	const preferredDirs = assetSubdirsForMethod(method);
	const candidates: string[] = [];

	for (const grailsApp of grailsAppRoots) {
		const assetsRoot = path.join(grailsApp, 'assets');
		for (const sub of preferredDirs) {
			candidates.push(...assetCandidatesForFile(path.join(assetsRoot, sub), normalized, method));
		}
		candidates.push(...assetCandidatesForFile(assetsRoot, normalized, method));
	}

	return candidates.find(candidate => fs.existsSync(candidate));
}

/**
 * Asset Pipeline tags often say `foo.css` while the editable source is `foo.scss`.
 * Prefer preprocessor sources over the literal `.css` path when both exist.
 */
function assetCandidatesForFile(
	directory: string,
	normalizedSrc: string,
	method: string | undefined
): string[] {
	const ext = path.extname(normalizedSrc).toLowerCase();
	const withoutExt = ext ? normalizedSrc.slice(0, -ext.length) : normalizedSrc;
	const ordered: string[] = [];

	if (ext === '.css' || method === 'stylesheet' || method === 'css') {
		for (const sourceExt of ['.scss', '.sass', '.less']) {
			ordered.push(path.join(directory, `${withoutExt}${sourceExt}`));
		}
	}
	if (ext === '.js' || method === 'javascript' || method === 'js') {
		for (const sourceExt of ['.ts', '.coffee', '.jsx', '.tsx']) {
			ordered.push(path.join(directory, `${withoutExt}${sourceExt}`));
		}
	}

	// Exact path from the tag (e.g. dashboard/dashboardHome.css)
	ordered.push(path.join(directory, normalizedSrc));

	if (!ext) {
		for (const fallbackExt of extensionsForMethod(method)) {
			if (fallbackExt === '.css') {
				for (const sourceExt of ['.scss', '.sass', '.less']) {
					ordered.push(path.join(directory, `${normalizedSrc}${sourceExt}`));
				}
			}
			ordered.push(path.join(directory, `${normalizedSrc}${fallbackExt}`));
		}
	}

	return ordered;
}

function assetSubdirsForMethod(method: string | undefined): string[] {
	switch (method) {
		case 'stylesheet':
		case 'css':
			return ['stylesheets', 'css'];
		case 'javascript':
		case 'js':
			return ['javascripts', 'js'];
		case 'image':
			return ['images'];
		default:
			return ['stylesheets', 'javascripts', 'images', 'css', 'js'];
	}
}

function extensionsForMethod(method: string | undefined): string[] {
	switch (method) {
		case 'stylesheet':
		case 'css':
			return ['.css'];
		case 'javascript':
		case 'js':
			return ['.js'];
		case 'image':
			return ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'];
		default:
			return ['.css', '.js'];
	}
}

export function collectGrailsAppRoots(workspaceRoot: string): string[] {
	const roots: string[] = [];
	const seen = new Set<string>();
	const push = (dir: string) => {
		const resolved = path.resolve(dir);
		if (!seen.has(resolved) && fs.existsSync(resolved)) {
			seen.add(resolved);
			roots.push(resolved);
		}
	};

	push(path.join(workspaceRoot, 'grails-app'));
	for (const moduleName of ['web', 'api', 'domain', 'app']) {
		push(path.join(workspaceRoot, moduleName, 'grails-app'));
	}

	// One level of submodules: root/*/grails-app
	try {
		for (const entry of fs.readdirSync(workspaceRoot, { withFileTypes: true })) {
			if (entry.isDirectory() && !entry.name.startsWith('.')) {
				push(path.join(workspaceRoot, entry.name, 'grails-app'));
			}
		}
	} catch {
		// ignore
	}

	return roots;
}

function firstExisting(grailsAppRoots: string[], relative: string): string | undefined {
	const normalized = relative.replace(/\\/g, '/').replace(/^\/+/, '');
	for (const grailsApp of grailsAppRoots) {
		const candidate = path.join(path.dirname(grailsApp), normalized);
		if (fs.existsSync(candidate)) {
			return candidate;
		}
		const underApp = path.join(grailsApp, normalized);
		if (fs.existsSync(underApp)) {
			return underApp;
		}
	}
	return undefined;
}
