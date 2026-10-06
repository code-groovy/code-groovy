import * as fs from 'fs';
import * as path from 'path';

export type GrailsArtifactKind = 'controller' | 'service' | 'domain' | 'view' | 'job' | 'taglib' | 'class';

export interface GrailsArtifactEntry {
	kind: GrailsArtifactKind;
	className: string;
	filePath: string;
	packageName?: string;
}

export class GrailsArtifactIndex {
	private readonly entries = new Map<string, GrailsArtifactEntry[]>();

	clear(): void {
		this.entries.clear();
	}

	addEntry(entry: GrailsArtifactEntry): void {
		const list = this.entries.get(entry.className) ?? [];
		if (list.some(existing => existing.filePath === entry.filePath)) {
			return;
		}
		list.push(entry);
		this.entries.set(entry.className, list);
	}

	removeEntry(entry: GrailsArtifactEntry): void {
		const list = this.entries.get(entry.className)?.filter(existing => existing.filePath !== entry.filePath);
		if (list && list.length > 0) {
			this.entries.set(entry.className, list);
		} else {
			this.entries.delete(entry.className);
		}
	}

	findAllByClassName(className: string): GrailsArtifactEntry[] {
		const found = this.entries.get(className);
		if (!found || found.length < 2) {
			return found ?? [];
		}
		return [...found].sort(
			(a, b) => Number(isTestPath(a.filePath)) - Number(isTestPath(b.filePath))
		);
	}

	findByClassName(className: string): GrailsArtifactEntry | undefined {
		return this.findAllByClassName(className)[0];
	}

	classNameCount(): number {
		return this.entries.size;
	}

	entryCount(): number {
		let count = 0;
		for (const list of this.entries.values()) {
			count += list.length;
		}
		return count;
	}
}

export function indexGroovyFile(filePath: string, packageName: string | undefined = readPackageName(filePath)): GrailsArtifactEntry {
	const className = path.basename(filePath, '.groovy');
	return {
		kind: detectKind(className, filePath),
		className,
		filePath,
		packageName
	};
}

export function isTestPath(filePath: string): boolean {
	return /[/\\](?:test|integration-test)[/\\]/.test(filePath);
}

function detectKind(className: string, filePath: string): GrailsArtifactKind {
	if (className.endsWith('Controller')) {
		return 'controller';
	}
	if (className.endsWith('Service')) {
		return 'service';
	}
	if (className.endsWith('Job')) {
		return 'job';
	}
	if (className.endsWith('TagLib')) {
		return 'taglib';
	}
	if (filePath.includes(`${path.sep}domain${path.sep}`)) {
		return 'domain';
	}
	return 'class';
}

function readPackageName(filePath: string): string | undefined {
	try {
		const fd = fs.openSync(filePath, 'r');
		const buffer = Buffer.alloc(1024);
		const bytesRead = fs.readSync(fd, buffer, 0, 1024, 0);
		fs.closeSync(fd);
		const head = buffer.toString('utf8', 0, bytesRead);
		const match = head.match(/^package\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/m);
		return match?.[1];
	} catch {
		return undefined;
	}
}
