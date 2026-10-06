import { CallSiteRecord } from './call_site_extractor';
import { CallSiteIndexStore } from './call_site_index_store';
import { ClassIndexStore } from './class_index_store';
import { GrailsArtifactIndex } from './grails_artifact_index';
import { IndexedSource } from './source_indexer';
import { TypeHierarchyStore } from './type_hierarchy_store';

export interface IndexStores {
	classStore: ClassIndexStore;
	callSiteIndex: CallSiteIndexStore;
	typeHierarchy: TypeHierarchyStore;
	artifactIndex: GrailsArtifactIndex;
}

export function rebuildIndexStores(stores: IndexStores, sources: Map<string, IndexedSource>): void {
	stores.artifactIndex.clear();
	stores.classStore.removeBySource('workspace');
	stores.callSiteIndex.clear();
	stores.typeHierarchy.clear();
	const callSites: CallSiteRecord[] = [];
	for (const [filePath, indexed] of sources) {
		addSource(stores, filePath, indexed, callSites);
	}
	stores.callSiteIndex.add(callSites);
}

export function updateIndexStores(
	stores: IndexStores,
	previous: Map<string, IndexedSource>,
	indexed: Set<string>,
	sources: Map<string, IndexedSource>
): void {
	for (const [filePath, stale] of previous) {
		stores.classStore.remove(stale.types);
		stores.typeHierarchy.removeFile(filePath, stale.types, stale.methods, stale.fields, stale.enumConstants);
		stores.callSiteIndex.removeFile(filePath, stale.callSites, stale.typeMentions);
		if (stale.artifactEntry) {
			stores.artifactIndex.removeEntry(stale.artifactEntry);
		}
	}
	const callSites: CallSiteRecord[] = [];
	for (const filePath of indexed) {
		const current = sources.get(filePath);
		if (current) {
			addSource(stores, filePath, current, callSites);
		}
	}
	stores.callSiteIndex.add(callSites);
}

function addSource(stores: IndexStores, filePath: string, indexed: IndexedSource, callSites: CallSiteRecord[]): void {
	stores.classStore.add(indexed.types);
	stores.typeHierarchy.add(indexed.types, indexed.methods, indexed.imports, indexed.fields, indexed.enumConstants);
	stores.callSiteIndex.addTypeMentions(filePath, indexed.typeMentions);
	for (const callSite of indexed.callSites) {
		callSites.push(callSite);
	}
	if (indexed.artifactEntry) {
		stores.artifactIndex.addEntry(indexed.artifactEntry);
	}
}
