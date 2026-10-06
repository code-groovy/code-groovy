import * as assert from 'assert';
import { CallSiteIndexStore } from '../../groovy/call_site_index_store';
import { ClassIndexStore } from '../../groovy/class_index_store';
import { GrailsArtifactIndex } from '../../groovy/grails_artifact_index';
import { IndexStores, rebuildIndexStores, updateIndexStores } from '../../groovy/index_stores';
import { IndexedSource, indexSourceText } from '../../groovy/source_indexer';
import { TypeHierarchyStore } from '../../groovy/type_hierarchy_store';

function newStores(): IndexStores {
	return {
		classStore: new ClassIndexStore(),
		callSiteIndex: new CallSiteIndexStore(),
		typeHierarchy: new TypeHierarchyStore(),
		artifactIndex: new GrailsArtifactIndex()
	};
}

function index(files: Record<string, string>): Map<string, IndexedSource> {
	return new Map(Object.entries(files).map(([filePath, text]) => [filePath, indexSourceText(text, filePath)]));
}

function snapshot(stores: IndexStores): string[] {
	const calls = (name: string) => stores.callSiteIndex.lookup(name).map(record => `${record.sourcePath}:${record.line}:${record.column}`).sort().join(',');
	return [
		`save=${calls('save')}`,
		`build=${calls('build')}`,
		`receivers=${stores.callSiteIndex.lookupByReceiver('Widget').map(record => record.sourcePath).sort().join(',')}`,
		`mentions=${stores.callSiteIndex.filesMentioning('Widget').sort().join(',')}`,
		`types=${stores.classStore.lookup('Widget').map(type => type.fqn).sort().join(',')}|${stores.classStore.lookup('Gadget').map(type => type.fqn).join(',')}`,
		`parents=${stores.typeHierarchy.parentsOf('a.Special').join(',')}`,
		`methods=${stores.typeHierarchy.methodDeclarations('a.Widget', 'save').map(declaration => declaration.line).join(',')}`,
		`member=${stores.typeHierarchy.memberType('a.Widget', 'name') ?? '-'}`,
		`artifacts=${stores.artifactIndex.findAllByClassName('Widget').length}/${stores.artifactIndex.findAllByClassName('Gadget').length}`
	];
}

suite('index stores', () => {
	const before: Record<string, string> = {
		'/w/a/Widget.groovy': 'package a\nclass Widget {\n    String name\n    void save() {}\n}',
		'/w/a/Special.groovy': 'package a\nclass Special extends Widget {\n    void run() { save() }\n}',
		'/w/a/Caller.groovy': 'package a\nclass Caller {\n    def run(Widget widget) {\n        widget.save()\n        Widget.build()\n    }\n}',
		'/w/a/Gone.groovy': 'package a\nclass Gadget {\n    void save() {}\n}'
	};
	const after: Record<string, string> = {
		'/w/a/Widget.groovy': 'package a\nclass Widget {\n    Long name\n\n    void save() {}\n}',
		'/w/a/Special.groovy': before['/w/a/Special.groovy'],
		'/w/a/Caller.groovy': 'package a\nclass Caller {\n    def run(Widget widget) {\n        widget.save()\n    }\n}',
		'/w/a/New.groovy': 'package a\nclass Other {\n    def go(Widget w) { w.save(); Widget.build() }\n}'
	};

	test('updating the changed, added and removed files gives the same stores as a full rebuild', () => {
		const incremental = newStores();
		const sources = index(before);
		rebuildIndexStores(incremental, sources);
		const previous = new Map([...sources].filter(([filePath]) => ['/w/a/Widget.groovy', '/w/a/Caller.groovy', '/w/a/Gone.groovy'].includes(filePath)));
		const updated = index(after);
		updateIndexStores(incremental, previous, new Set(['/w/a/Widget.groovy', '/w/a/Caller.groovy', '/w/a/New.groovy']), updated);
		const full = newStores();
		rebuildIndexStores(full, updated);
		assert.deepStrictEqual(snapshot(incremental), snapshot(full));
		assert.deepStrictEqual(snapshot(full)[8], 'artifacts=1/0');
	});

	test('a rebuild after clear gives the same stores again', () => {
		const stores = newStores();
		const sources = index(before);
		rebuildIndexStores(stores, sources);
		const first = snapshot(stores);
		rebuildIndexStores(stores, sources);
		assert.deepStrictEqual(snapshot(stores), first);
	});
});
