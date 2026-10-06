import * as assert from 'assert';
import { TypeHierarchyStore } from '../../groovy/type_hierarchy_store';

suite('TypeHierarchyStore', () => {
	test('resolves parents through explicit imports, the same package, wildcard imports or a unique name', () => {
		const hierarchy = new TypeHierarchyStore();
		hierarchy.add([{ simpleName: 'Base', fqn: 'x.Base' }, { simpleName: 'Base', fqn: 'y.Base' }, { simpleName: 'Unique', fqn: 'z.Unique' }], []);
		hierarchy.add([{ simpleName: 'A', fqn: 'p.A', extendsTypes: ['Base'] }], [], ['y.Base']);
		hierarchy.add([{ simpleName: 'B', fqn: 'x.B', extendsTypes: ['Base'], implementsTypes: ['Unique'] }], []);
		hierarchy.add([{ simpleName: 'C', fqn: 'q.C', extendsTypes: ['Base'] }], [], ['y.*']);
		hierarchy.add([{ simpleName: 'D', fqn: 'q.D', extendsTypes: ['Base'] }], []);
		assert.deepStrictEqual(hierarchy.parentsOf('p.A'), ['y.Base']);
		assert.deepStrictEqual(hierarchy.parentsOf('x.B'), ['x.Base', 'z.Unique']);
		assert.deepStrictEqual(hierarchy.parentsOf('q.C'), ['y.Base']);
		assert.deepStrictEqual(hierarchy.parentsOf('q.D'), []);
		assert.deepStrictEqual(hierarchy.childrenOf('y.Base').sort(), ['p.A', 'q.C']);
	});

});

suite('TypeHierarchyStore — members, per-file types and removal', () => {
	const build = () => {
		const hierarchy = new TypeHierarchyStore();
		hierarchy.add([{ simpleName: 'Order', fqn: 'a.Order', sourcePath: '/w/a/Order.groovy' }], [], [], [{ classFqn: 'a.Order', name: 'status', typeName: 'Status' }]);
		hierarchy.add([{ simpleName: 'Status', fqn: 'a.Status', sourcePath: '/w/a/Status.groovy' }], [], [], [], [{ classFqn: 'a.Status', name: 'PAID' }]);
		hierarchy.add([{ simpleName: 'Base', fqn: 'lib.one.Base', sourcePath: '/w/lib/one/Base.groovy' }], []);
		hierarchy.add([{ simpleName: 'Base', fqn: 'lib.two.Base', sourcePath: '/w/lib/two/Base.groovy' }], []);
		hierarchy.add(
			[{ simpleName: 'Child', fqn: 'app.Child', sourcePath: '/w/app/Child.groovy', extendsTypes: ['OneBase'] }],
			[],
			['lib.one.Base as OneBase', 'lib.two.*']
		);
		return hierarchy;
	};

	test('types fields and enum constants', () => {
		const hierarchy = build();
		assert.strictEqual(hierarchy.memberType('a.Order', 'status'), 'Status');
		assert.strictEqual(hierarchy.memberType('a.Status', 'PAID'), 'Status');
		assert.strictEqual(hierarchy.memberType('a.Order', 'missing'), undefined);
	});

	test('resolves names as each file sees them, through aliases and wildcard imports', () => {
		const hierarchy = build();
		assert.deepStrictEqual(hierarchy.parentsOf('app.Child'), ['lib.one.Base']);
		assert.strictEqual(hierarchy.resolveTypeIn('/w/app/Child.groovy', 'OneBase'), 'lib.one.Base');
		assert.strictEqual(hierarchy.resolveTypeIn('/w/app/Child.groovy', 'Base'), 'lib.two.Base');
		assert.strictEqual(hierarchy.resolveTypeIn('/w/a/Order.groovy', 'Status'), 'a.Status');
		assert.strictEqual(hierarchy.sourceOf('a.Status'), '/w/a/Status.groovy');
	});

	test('forgets everything a removed file contributed', () => {
		const hierarchy = build();
		hierarchy.removeFile('/w/a/Status.groovy', [{ simpleName: 'Status', fqn: 'a.Status', sourcePath: '/w/a/Status.groovy' }], [], [], [{ classFqn: 'a.Status', name: 'PAID' }]);
		assert.deepStrictEqual(hierarchy.resolveClass('Status'), []);
		assert.strictEqual(hierarchy.memberType('a.Status', 'PAID'), undefined);
		assert.strictEqual(hierarchy.sourceOf('a.Status'), undefined);
	});
});
