import { packageNameFromFqn } from './class_index_store';
import { listExistingImports, parsePackageName } from './class_parser';
import { compareImportLines } from './import_order_logic';

export interface ImportInsertion {
	/** Offset in the document text where the import line should be inserted. */
	offset: number;
	/** Full text to insert, including trailing newline. */
	text: string;
	/** Whether an import is actually needed. */
	needed: boolean;
}

/**
 * Computes where/how to insert `import fqn` into a Groovy/Java source file.
 * Places the new import in lexicographic order among existing imports without
 * reordering any lines that are already present.
 */
export function planImportInsertion(documentText: string, fqn: string): ImportInsertion {
	const packageName = parsePackageName(documentText);
	const typePackage = packageNameFromFqn(fqn);

	if (typePackage && typePackage === packageName) {
		return { offset: 0, text: '', needed: false };
	}

	const existing = listExistingImports(documentText);
	if (existing.has(fqn) || existing.has(typePackage)) {
		// exact import or star import of the package
		return { offset: 0, text: '', needed: false };
	}

	const importLine = `import ${fqn}`;
	const lines = documentText.split(/\n/);
	for (const line of lines) {
		if (line.trim() === importLine || line.trim() === `${importLine};`) {
			return { offset: 0, text: '', needed: false };
		}
	}

	const offset = findSortedImportInsertOffset(documentText, importLine);
	return {
		offset,
		text: `${importLine}\n`,
		needed: true
	};
}

/**
 * Finds the offset to insert `importLine` so it sits in sorted order among
 * current imports. Existing out-of-order imports are left untouched.
 */
export function findSortedImportInsertOffset(documentText: string, importLine: string): number {
	const target = importLine.trim();
	const lines = documentText.split('\n');
	let offset = 0;
	let afterPackage = 0;
	let afterLastImport: number | undefined;
	let insertBeforeOffset: number | undefined;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const newline = i < lines.length - 1 ? 1 : 0;
		const lineStart = offset;
		const lineEnd = offset + line.length + newline;
		const trimmed = line.trim();

		if (/^package\b/.test(trimmed)) {
			afterPackage = lineEnd;
		} else if (/^import\b/.test(trimmed)) {
			afterLastImport = lineEnd;
			if (insertBeforeOffset === undefined && compareImportLines(trimmed, target) > 0) {
				insertBeforeOffset = lineStart;
			}
		} else if (trimmed && (afterPackage || afterLastImport !== undefined)) {
			break;
		}

		offset = lineEnd;
	}

	return insertBeforeOffset ?? afterLastImport ?? afterPackage;
}

export function applyImportInsertion(documentText: string, insertion: ImportInsertion): string {
	if (!insertion.needed) {
		return documentText;
	}
	return (
		documentText.slice(0, insertion.offset) +
		insertion.text +
		documentText.slice(insertion.offset)
	);
}

export function needsImport(documentText: string, fqn: string): boolean {
	return planImportInsertion(documentText, fqn).needed;
}
