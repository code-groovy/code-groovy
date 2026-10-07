import * as assert from 'assert';
import { CallSiteIndexStore } from '../../groovy/call_site_index_store';
import { analyzeSource, excludeDeclarationCallSites } from '../../groovy/call_site_extractor';
import { constructorDeclarations, parseDocumentSymbols } from '../../groovy/symbol_parser';
import { parseImports } from '../../groovy/class_parser';
import { findWordMatches } from '../../groovy/text_scan_logic';
import { PropertyScan, propertyReadLocations } from '../../groovy/property_access_logic';
import { TypeHierarchyStore } from '../../groovy/type_hierarchy_store';
import {
	collectUsageLocations,
	declarationLocations,
	excludePosition,
	findDeclarationTarget,
	findReferenceTarget,
	resolveUsages,
	TextScan,
	UsageLocation,
	UsageResolution
} from '../../groovy/usage_lookup_logic';

const WIDGET_SERVICE = '/tmp/WidgetService.groovy';

function buildIndex(files: Record<string, string>): CallSiteIndexStore {
	const index = new CallSiteIndexStore();
	const callSites = [];
	const methods = [];
	for (const [sourcePath, text] of Object.entries(files)) {
		const analysis = analyzeSource(text, sourcePath);
		callSites.push(...analysis.callSites);
		const symbols = parseDocumentSymbols(text, sourcePath);
		methods.push(...symbols.methods, ...constructorDeclarations(symbols, sourcePath));
		index.addTypeMentions(sourcePath, analysis.typeMentions);
	}
	index.add(excludeDeclarationCallSites(callSites, methods));
	return index;
}

function buildHierarchy(files: Record<string, string>): TypeHierarchyStore {
	const hierarchy = new TypeHierarchyStore();
	for (const [sourcePath, text] of Object.entries(files)) {
		const symbols = parseDocumentSymbols(text, sourcePath);
		hierarchy.add(
			symbols.classes,
			symbols.methods,
			parseImports(text),
			symbols.fields.filter(field => field.classMember).map(field => ({ classFqn: field.classFqn, name: field.name, typeName: field.typeName })),
			symbols.enumConstants.map(constant => ({ classFqn: constant.enumFqn, name: constant.name }))
		);
	}
	return hierarchy;
}

function describe(records: Array<{ sourcePath: string; line: number }>): string[] {
	return records.map(record => `${record.sourcePath}:${record.line}`).sort();
}

suite('findDeclarationTarget', () => {
	const source = [
		'class WidgetService {',
		'    Map<String, Object> rename(Long id) {',
		'        widget.save(flush: true)',
		'    }',
		'    static create(String name) {',
		'    }',
		'    private helper() {',
		'    }',
		'    public WidgetService(String name) {',
		'    }',
		'}'
	].join('\n');

	test('detects a class declaration', () => {
		assert.deepStrictEqual(findDeclarationTarget(source, WIDGET_SERVICE, 0, 'WidgetService'), { kind: 'class', name: 'WidgetService', classFqn: 'WidgetService' });
	});

	test('detects a method declaration with a generic return type', () => {
		assert.deepStrictEqual(findDeclarationTarget(source, WIDGET_SERVICE, 1, 'rename'), {
			kind: 'method',
			name: 'rename',
			className: 'WidgetService',
			classFqn: 'WidgetService'
		});
	});

	test('detects methods declared with modifiers and no return type', () => {
		assert.strictEqual(findDeclarationTarget(source, WIDGET_SERVICE, 4, 'create')?.kind, 'method');
		assert.strictEqual(findDeclarationTarget(source, WIDGET_SERVICE, 6, 'helper')?.kind, 'method');
	});

	test('attributes methods after a nested type to the outer class', () => {
		const nested = [
			'class PaymentService {',
			'    static enum Kind { A, B }',
			'    def process(Long id) {',
			'    }',
			'}'
		].join('\n');
		assert.deepStrictEqual(findDeclarationTarget(nested, '/tmp/PaymentService.groovy', 2, 'process'), {
			kind: 'method',
			name: 'process',
			className: 'PaymentService',
			classFqn: 'PaymentService'
		});
	});

	test('treats a same-line call with the declared name as a call, not as the declaration', () => {
		const text = 'class Invoice {\n    Boolean isPaid() { return payment.isPaid() }\n}';
		const lineText = text.split('\n')[1];
		assert.strictEqual(findDeclarationTarget(text, '/tmp/Invoice.groovy', 1, 'isPaid', lineText.lastIndexOf('isPaid')), undefined);
		assert.strictEqual(findDeclarationTarget(text, '/tmp/Invoice.groovy', 1, 'isPaid', lineText.indexOf('isPaid'))?.kind, 'method');
	});

	test('treats a constructor declaration as its class', () => {
		assert.deepStrictEqual(findDeclarationTarget(source, WIDGET_SERVICE, 8, 'WidgetService'), { kind: 'class', name: 'WidgetService', classFqn: 'WidgetService' });
	});

	test('returns nothing for a call that is not a declaration', () => {
		assert.strictEqual(findDeclarationTarget(source, WIDGET_SERVICE, 2, 'save'), undefined);
	});
});

suite('findReferenceTarget', () => {
	const source = [
		'class WidgetController {',
		'    def show(Widget item) {',
		'        widgetService.rename(1L)',
		'        this.render(view)',
		'        audit(id)',
		'        Widget widget = Widget.get(id)',
		'        println widget',
		'        item.touch()',
		'    }',
		'}'
	].join('\n');
	const controller = '/tmp/WidgetController.groovy';
	const lines = source.split('\n');

	function targetAt(line: number, word: string, occurrence: 'first' | 'last' = 'first') {
		const start = occurrence === 'first' ? lines[line].indexOf(word) : lines[line].lastIndexOf(word);
		return findReferenceTarget(source, controller, line, start, word);
	}

	test('resolves a service bean receiver to its class', () => {
		assert.deepStrictEqual(targetAt(2, 'rename'), { kind: 'method', name: 'rename', className: 'WidgetService' });
	});

	test('resolves a typed receiver to its declared class', () => {
		assert.deepStrictEqual(targetAt(7, 'touch'), { kind: 'method', name: 'touch', className: 'Widget' });
	});

	test('treats this.method() and bare calls as calls on the owning class', () => {
		assert.deepStrictEqual(targetAt(3, 'render'), { kind: 'method', name: 'render', className: 'WidgetController' });
		assert.deepStrictEqual(targetAt(4, 'audit'), { kind: 'method', name: 'audit', className: 'WidgetController' });
	});

	test('treats a capitalized word as a class', () => {
		assert.deepStrictEqual(targetAt(5, 'Widget', 'last'), { kind: 'class', name: 'Widget' });
	});

	test('returns nothing for a plain variable', () => {
		assert.strictEqual(targetAt(6, 'widget', 'last'), undefined);
	});
});

suite('resolveUsages — methods', () => {
	const target = { kind: 'method' as const, name: 'rename', className: 'WidgetService' };

	test('keeps callers through the Grails field name plus calls inside the declaring class', () => {
		const index = buildIndex({
			'/tmp/WidgetController.groovy': 'widgetService.rename(1L)\nwidgetService?.rename(2L)',
			'/tmp/OtherController.groovy': 'otherService.rename(3L)',
			[WIDGET_SERVICE]: 'def bulk() {\n    rename(4L)\n    this.rename(5L)\n}'
		});
		const resolution = resolveUsages(target, index, 'navigate');
		assert.deepStrictEqual(describe(resolution.records), [
			'/tmp/WidgetController.groovy:0',
			'/tmp/WidgetController.groovy:1',
			`${WIDGET_SERVICE}:1`,
			`${WIDGET_SERVICE}:2`
		]);
		assert.deepStrictEqual(resolution.textScans, []);
	});

	test('keeps static calls and calls through variables typed with the class, next to internal calls', () => {
		const index = buildIndex({
			'/tmp/Widget.groovy': 'class Widget {\n    static build(String name) {\n    }\n    def copy() {\n        build(name)\n    }\n}',
			'/tmp/Factory.groovy': 'Widget.build("a")\ndef make(Widget w) {\n    w.build("b")\n}\ndef other(Order w) {\n    w.build("c")\n}'
		});
		const resolution = resolveUsages({ kind: 'method', name: 'build', className: 'Widget' }, index, 'navigate');
		assert.deepStrictEqual(describe(resolution.records), ['/tmp/Factory.groovy:0', '/tmp/Factory.groovy:2', '/tmp/Widget.groovy:4']);
	});

	test('returns nothing instead of unrelated same-named calls when no call is scoped', () => {
		const index = buildIndex({ '/tmp/Order.groovy': 'order.save(flush: true)\ncustomer.save()' });
		const resolution = resolveUsages({ kind: 'method', name: 'save', className: 'WidgetService' }, index, 'navigate');
		assert.deepStrictEqual(resolution.records, []);
		assert.deepStrictEqual(resolution.textScans, []);
	});

	test('decides by the declared type when there is one, even if the variable is named like the class field', () => {
		const index = buildIndex({
			'/tmp/Caller.groovy': 'class Caller {\n    def run() {\n        CustomerDTO payment = build()\n        payment.confirm()\n        payment2.confirm()\n    }\n}',
			'/tmp/Other.groovy': 'class Other {\n    def run() {\n        payment.confirm()\n    }\n}'
		});
		const resolution = resolveUsages({ kind: 'method', name: 'confirm', className: 'Payment' }, index, 'navigate');
		assert.deepStrictEqual(describe(resolution.records), ['/tmp/Other.groovy:2']);
	});

	test('does not count the end of a call chain as a call inside the file class', () => {
		const index = buildIndex({
			'/tmp/Customer.groovy': 'class Customer {\n    def run() {\n        Payment.findAll().confirm()\n        confirm()\n    }\n}'
		});
		const resolution = resolveUsages({ kind: 'method', name: 'confirm', className: 'Customer' }, index, 'navigate');
		assert.deepStrictEqual(describe(resolution.records), ['/tmp/Customer.groovy:3']);
	});

	test('asks for a scoped text scan only while the index is not ready', () => {
		const empty = new CallSiteIndexStore();
		assert.deepStrictEqual(resolveUsages(target, empty, 'navigate').textScans, [{ scope: 'workspace', receiverFieldName: 'widgetService' }]);
		empty.add([]);
		assert.deepStrictEqual(resolveUsages(target, empty, 'navigate').textScans, []);
	});
});

suite('resolveUsages — classes', () => {
	const index = buildIndex({
		'/tmp/A.groovy': 'Widget.get(1)\nWidget.where { name == x }\nnew Widget(name: x)',
		'/tmp/B.groovy': 'widgetService.rename(1L)',
		'/tmp/C.groovy': 'class Report {\n    Invoice invoice\n}',
		'/tmp/D.groovy': 'import com.x.Invoice\n// Invoice mentioned only here'
	});

	test('combines static/closure calls and constructor calls', () => {
		const resolution = resolveUsages({ kind: 'class', name: 'Widget' }, index, 'navigate');
		assert.deepStrictEqual(describe(resolution.records), ['/tmp/A.groovy:0', '/tmp/A.groovy:1', '/tmp/A.groovy:2']);
		assert.deepStrictEqual(resolution.textScans, []);
	});

	test('recognizes untyped service injection through the Grails field name', () => {
		const resolution = resolveUsages({ kind: 'class', name: 'WidgetService' }, index, 'navigate');
		assert.deepStrictEqual(describe(resolution.records), ['/tmp/B.groovy:0']);
	});

	test('scans only the files that mention a class used only as a type, ignoring imports and comments', () => {
		const resolution = resolveUsages({ kind: 'class', name: 'Invoice' }, index, 'navigate');
		assert.deepStrictEqual(resolution.records, []);
		assert.deepStrictEqual(resolution.textScans, [{ scope: 'files', files: ['/tmp/C.groovy'] }]);
	});

	test('skips the text scan entirely when no file mentions the class', () => {
		assert.deepStrictEqual(resolveUsages({ kind: 'class', name: 'Orphan' }, index, 'navigate').textScans, []);
	});

	test('scans the mentioning files for Find All References, to include type references', () => {
		assert.deepStrictEqual(resolveUsages({ kind: 'class', name: 'Widget' }, index, 'references').textScans, [{ scope: 'files', files: ['/tmp/A.groovy'] }]);
	});
});

suite('resolveUsages — type hierarchy', () => {
	const files: Record<string, string> = {
		'/tmp/CronJob.groovy': [
			'trait CronJob {',
			'    public static Boolean isActive() {',
			'        CronJob jobInstance = this.newInstance()',
			'        return jobInstance.allowedEnvironments().contains(1)',
			'    }',
			'    public void execute() {',
			'        task()',
			'    }',
			'    public abstract void task()',
			'    public abstract List<String> allowedEnvironments()',
			'    public abstract List<String> listExecutionExpression()',
			'}'
		].join('\n'),
		'/tmp/ExpiredJob.groovy': [
			'class ExpiredJob implements CronJob {',
			'    @Override',
			'    void task() {',
			'    }',
			'    @Override',
			'    List<String> allowedEnvironments() {',
			'        return []',
			'    }',
			'    @Override',
			'    List<String> listExecutionExpression() {',
			'        return []',
			'    }',
			'}'
		].join('\n'),
		'/tmp/UnrelatedService.groovy': 'class UnrelatedService {\n    void task() {\n    }\n    void run() {\n        task()\n    }\n}',
		'/tmp/BaseService.groovy': 'class BaseService {\n    void audit(String message) {\n    }\n}',
		'/tmp/ChildService.groovy': 'class ChildService extends BaseService {\n    void run() {\n        audit("x")\n        super.audit("y")\n    }\n}',
		'/tmp/Caller.groovy': 'class Caller {\n    def childService\n    def run() {\n        childService.audit("z")\n    }\n}'
	};
	const index = buildIndex(files);
	const hierarchy = buildHierarchy(files);

	test('an overriding method includes calls made through the trait that declares it', () => {
		const task = resolveUsages({ kind: 'method', name: 'task', className: 'ExpiredJob' }, index, 'navigate', hierarchy);
		assert.deepStrictEqual(describe(task.records), ['/tmp/CronJob.groovy:6']);
		const environments = resolveUsages({ kind: 'method', name: 'allowedEnvironments', className: 'ExpiredJob' }, index, 'navigate', hierarchy);
		assert.deepStrictEqual(describe(environments.records), ['/tmp/CronJob.groovy:3']);
	});

	test('an inherited method includes calls from subclasses, through super and through subclass fields', () => {
		const resolution = resolveUsages({ kind: 'method', name: 'audit', className: 'BaseService' }, index, 'navigate', hierarchy);
		assert.deepStrictEqual(describe(resolution.records), ['/tmp/Caller.groovy:3', '/tmp/ChildService.groovy:2', '/tmp/ChildService.groovy:3']);
	});

	test('falls back to the declaration in the supertype when nothing calls the method', () => {
		const resolution = resolveUsages({ kind: 'method', name: 'listExecutionExpression', className: 'ExpiredJob' }, index, 'navigate', hierarchy);
		assert.deepStrictEqual(resolution.records, []);
		assert.deepStrictEqual(resolution.superDeclarations, [{ sourcePath: '/tmp/CronJob.groovy', line: 10, column: files['/tmp/CronJob.groovy'].split('\n')[10].indexOf('listExecutionExpression') }]);
	});

	test('keeps the scope to the class itself without a hierarchy', () => {
		const resolution = resolveUsages({ kind: 'method', name: 'task', className: 'ExpiredJob' }, index, 'navigate');
		assert.deepStrictEqual(resolution.records, []);
		assert.deepStrictEqual(resolution.superDeclarations, []);
	});
});

suite('resolveUsages — homonyms and overrides', () => {
	const files: Record<string, string> = {
		'/tmp/a/BaseDto.groovy': 'package a\nclass BaseDto {\n    Map toMap() {\n        [:]\n    }\n}',
		'/tmp/b/BaseDto.groovy': 'package b\nclass BaseDto {\n    Map toMap() {\n        [:]\n    }\n}',
		'/tmp/a/OrderDto.groovy': 'package a\nclass OrderDto extends BaseDto {\n}',
		'/tmp/c/PixDto.groovy': 'package c\nimport b.BaseDto\nclass PixDto extends BaseDto {\n}',
		'/tmp/a/CustomDto.groovy': 'package a\nclass CustomDto extends BaseDto {\n    Map toMap() {\n        super.toMap()\n    }\n}',
		'/tmp/a/Caller.groovy': [
			'package a',
			'class Caller {',
			'    def run(OrderDto order, PixDto pix, CustomDto custom) {',
			'        order.toMap()',
			'        pix.toMap()',
			'        custom.toMap()',
			'    }',
			'}'
		].join('\n')
	};
	const index = buildIndex(files);
	const hierarchy = buildHierarchy(files);

	test('follows only the subclasses of the base class in the right package', () => {
		const resolution = resolveUsages({ kind: 'method', name: 'toMap', className: 'BaseDto', classFqn: 'a.BaseDto' }, index, 'navigate', hierarchy);
		assert.deepStrictEqual(describe(resolution.records), ['/tmp/a/Caller.groovy:3', '/tmp/a/CustomDto.groovy:3']);
	});

	test('attributes calls on a subclass that overrides the method to the override, not its own super call', () => {
		const override = resolveUsages({ kind: 'method', name: 'toMap', className: 'CustomDto', classFqn: 'a.CustomDto' }, index, 'navigate', hierarchy);
		assert.deepStrictEqual(describe(override.records), ['/tmp/a/Caller.groovy:5']);
	});

	test('resolves the other homonym through its import', () => {
		const resolution = resolveUsages({ kind: 'method', name: 'toMap', className: 'BaseDto', classFqn: 'b.BaseDto' }, index, 'navigate', hierarchy);
		assert.deepStrictEqual(describe(resolution.records), ['/tmp/a/Caller.groovy:4']);
	});
});

suite('resolveUsages — receiver chains', () => {
	const files: Record<string, string> = {
		'/tmp/Status.groovy': 'enum Status {\n    PAID, OPEN\n    Boolean isFinished() {\n        true\n    }\n}',
		'/tmp/Customer.groovy': 'class Customer {\n    Boolean isFinished() {\n        false\n    }\n}',
		'/tmp/Order.groovy': 'class Order {\n    Status status\n    Customer buyer\n}',
		'/tmp/SpecialOrder.groovy': 'class SpecialOrder extends Order {\n}',
		'/tmp/Caller.groovy': [
			'class Caller {',
			'    def run(Order order, Customer status, SpecialOrder special) {',
			'        order.status?.isFinished()',
			'        Status.PAID.isFinished()',
			'        order.buyer.isFinished()',
			'        status.isFinished()',
			'        special.status.isFinished()',
			'    }',
			'}'
		].join('\n')
	};
	const index = buildIndex(files);
	const hierarchy = buildHierarchy(files);

	test('resolves property chains, enum constants and inherited fields through the index', () => {
		const resolution = resolveUsages({ kind: 'method', name: 'isFinished', className: 'Status', classFqn: 'Status' }, index, 'navigate', hierarchy);
		assert.deepStrictEqual(describe(resolution.records), ['/tmp/Caller.groovy:2', '/tmp/Caller.groovy:3', '/tmp/Caller.groovy:6']);
	});

	test('Find All References from a chained call resolves the chain like the index', () => {
		const lines = files['/tmp/Caller.groovy'].split('\n');
		const target = findReferenceTarget(files['/tmp/Caller.groovy'], '/tmp/Caller.groovy', 2, lines[2].indexOf('isFinished'), 'isFinished');
		assert.deepStrictEqual(target, { kind: 'method', name: 'isFinished', className: 'Status', chain: { rootType: 'Order', path: ['status'] } });
		const fromCall = resolveUsages(target!, index, 'references', hierarchy);
		const fromDeclaration = resolveUsages({ kind: 'method', name: 'isFinished', className: 'Status', classFqn: 'Status' }, index, 'references', hierarchy);
		assert.deepStrictEqual(describe(fromCall.records), describe(fromDeclaration.records));
		const buyerTarget = findReferenceTarget(files['/tmp/Caller.groovy'], '/tmp/Caller.groovy', 4, lines[4].indexOf('isFinished'), 'isFinished');
		assert.deepStrictEqual(describe(resolveUsages(buyerTarget!, index, 'references', hierarchy).records), ['/tmp/Caller.groovy:4', '/tmp/Caller.groovy:5']);
	});

	test('does not type the end of a chain with a local variable of the same name', () => {
		const resolution = resolveUsages({ kind: 'method', name: 'isFinished', className: 'Customer', classFqn: 'Customer' }, index, 'navigate', hierarchy);
		assert.deepStrictEqual(describe(resolution.records), ['/tmp/Caller.groovy:4', '/tmp/Caller.groovy:5']);
	});
});

suite('findReferenceTarget — receivers the index also understands', () => {
	const source = [
		'class Child extends Base {',
		'    def run() {',
		'        super.greet()',
		'        builder',
		'            .withName("a")',
		'        helper().greet()',
		'    }',
		'}'
	].join('\n');
	const lines = source.split('\n');
	const at = (line: number, word: string) => findReferenceTarget(source, '/tmp/Child.groovy', line, lines[line].indexOf(word), word);

	test('maps super to the superclass', () => {
		assert.deepStrictEqual(at(2, 'greet'), { kind: 'method', name: 'greet', className: 'Base' });
	});

	test('resolves the superclass of super through the imports or the package', () => {
		const superTarget = (text: string) => {
			const textLines = text.split('\n');
			const line = textLines.findIndex(candidate => candidate.includes('super.greet'));
			return findReferenceTarget(text, '/tmp/Child.groovy', line, textLines[line].indexOf('greet'), 'greet');
		};
		const body = 'class Child extends Base {\n    def run() {\n        super.greet()\n    }\n}';
		assert.deepStrictEqual(superTarget(`package p\nimport q.Base\n${body}`), { kind: 'method', name: 'greet', className: 'Base', classFqn: 'q.Base' });
		assert.deepStrictEqual(superTarget(`package p\n${body}`), { kind: 'method', name: 'greet', className: 'Base', classFqn: 'p.Base' });
	});

	test('uses a receiver on the previous line', () => {
		assert.deepStrictEqual(at(4, 'withName'), { kind: 'method', name: 'withName', className: 'Builder' });
	});

	test('returns nothing for the end of a call chain', () => {
		assert.strictEqual(at(5, 'greet'), undefined);
	});
});

suite('collectUsageLocations', () => {
	const noScan = async (): Promise<UsageLocation[]> => [];
	const describeLocations = (locations: UsageLocation[]) => locations.map(location => `${location.sourcePath}:${location.line}:${location.column}:${location.length}`);

	test('keeps a recursive call on the declaration line and drops only the declaration itself', async () => {
		const sourcePath = '/tmp/Math.groovy';
		const source = 'class Math {\n    int fact(int n) { n <= 1 ? 1 : n * fact(n - 1) }\n}';
		const index = buildIndex({ [sourcePath]: source });
		const target = findDeclarationTarget(source, sourcePath, 1, 'fact', 8)!;
		const resolution = resolveUsages(target, index, 'navigate');
		const recursiveColumn = source.split('\n')[1].lastIndexOf('fact');
		const locations = await collectUsageLocations(target, resolution, 'navigate', 'fact', noScan, { sourcePath, line: 1, column: 8 });
		assert.deepStrictEqual(describeLocations(locations), [`${sourcePath}:1:${recursiveColumn}:4`]);
	});

	test('points class usages at the receiver instead of the called method, also on a previous line', async () => {
		const index = buildIndex({
			'/tmp/Use.groovy': 'Widget.get(1)\nwidgetService.rename(2)\nWidget\n    .where { true }\nnew Widget()'
		});
		const target = { kind: 'class' as const, name: 'Widget' };
		const widgetLocations = await collectUsageLocations(target, resolveUsages(target, index, 'navigate'), 'navigate', 'Widget', noScan);
		assert.deepStrictEqual(describeLocations(widgetLocations).sort(), ['/tmp/Use.groovy:0:0:6', '/tmp/Use.groovy:2:0:6', '/tmp/Use.groovy:4:4:6']);
		const serviceTarget = { kind: 'class' as const, name: 'WidgetService' };
		const serviceLocations = await collectUsageLocations(serviceTarget, resolveUsages(serviceTarget, index, 'navigate'), 'navigate', 'WidgetService', noScan);
		assert.deepStrictEqual(describeLocations(serviceLocations), ['/tmp/Use.groovy:1:0:13']);
	});

	test('merges type references from the text scan with the call sites for Find All References', async () => {
		const index = buildIndex({ '/tmp/A.groovy': 'Widget.get(1)\nWidget w = build()' });
		const target = { kind: 'class' as const, name: 'Widget' };
		const scanned: UsageLocation[] = [
			{ sourcePath: '/tmp/A.groovy', line: 0, column: 0, length: 6 },
			{ sourcePath: '/tmp/A.groovy', line: 1, column: 0, length: 6 }
		];
		const locations = await collectUsageLocations(target, resolveUsages(target, index, 'references'), 'references', 'Widget', async () => scanned);
		assert.deepStrictEqual(describeLocations(locations), ['/tmp/A.groovy:0:0:6', '/tmp/A.groovy:1:0:6']);
	});

	test('scans the workspace for a method only when the index has no scoped call', async () => {
		const target = { kind: 'method' as const, name: 'rename', className: 'WidgetService' };
		const scans: unknown[] = [];
		const scanner = async (_word: string, scan: unknown) => {
			scans.push(scan);
			return [{ sourcePath: '/tmp/B.groovy', line: 3, column: 14, length: 6 }];
		};
		const locations = await collectUsageLocations(target, resolveUsages(target, new CallSiteIndexStore(), 'navigate'), 'navigate', 'rename', scanner);
		assert.deepStrictEqual(scans, [{ scope: 'workspace', receiverFieldName: 'widgetService' }]);
		assert.deepStrictEqual(describeLocations(locations), ['/tmp/B.groovy:3:14:6']);
	});

	test('falls back to the supertype declarations when nothing else is left', async () => {
		const target = { kind: 'method' as const, name: 'greet', className: 'Child' };
		const resolution: UsageResolution = { records: [], textScans: [], superDeclarations: [{ sourcePath: '/tmp/Base.groovy', line: 2, column: 9 }] };
		const locations = await collectUsageLocations(target, resolution, 'navigate', 'greet', noScan);
		assert.deepStrictEqual(describeLocations(locations), ['/tmp/Base.groovy:2:9:5']);
	});
});

suite('excludePosition', () => {
	test('drops only the target at the cursor, keeping a one-line enum reached from its constant', () => {
		const sourcePath = '/tmp/Kind.groovy';
		const targets = [
			{ uri: sourcePath, line: 0, column: 5 },
			{ uri: sourcePath, line: 0, column: 12 }
		];
		assert.deepStrictEqual(excludePosition(targets, { sourcePath, line: 0, column: 12 }), [{ uri: sourcePath, line: 0, column: 5 }]);
	});
});

suite('findDeclarationTarget and resolveUsages — constructors without modifiers', () => {
	const kindPath = '/tmp/WidgetKind.groovy';
	const kindSource = [
		'enum WidgetKind {',
		'    A("a")',
		'    final String code',
		'    WidgetKind(String code) {',
		'        this.code = code',
		'    }',
		'}'
	].join('\n');
	const index = buildIndex({ [kindPath]: kindSource, '/tmp/Use.groovy': 'def k = new WidgetKind("b")\nWidgetKind.values()' });

	test('treats the constructor name as its class', () => {
		assert.deepStrictEqual(findDeclarationTarget(kindSource, kindPath, 3, 'WidgetKind', 4), { kind: 'class', name: 'WidgetKind', classFqn: 'WidgetKind' });
	});

	test('does not index the constructor declaration as a call of the class', () => {
		const resolution = resolveUsages({ kind: 'class', name: 'WidgetKind' }, index, 'navigate');
		assert.deepStrictEqual(describe(resolution.records), ['/tmp/Use.groovy:0', '/tmp/Use.groovy:1']);
	});
});

suite('declarationLocations', () => {
	const files: Record<string, string> = {
		'/tmp/Foo.groovy': 'package a\nclass Foo {\n    void save() {}\n}',
		'/tmp/Bar.groovy': 'package a\nclass Bar extends Foo {\n}',
		'/tmp/Caller.groovy': 'package a\nclass Caller {\n    def run(Foo foo, Bar bar) {\n        foo.save()\n        bar.save()\n    }\n}'
	};
	const hierarchy = buildHierarchy(files);
	const describeLocations = (locations: UsageLocation[]) => locations.map(location => `${location.sourcePath}:${location.line}:${location.column}`);

	test('finds the declaration from a call on the declaring class', () => {
		const target = findReferenceTarget(files['/tmp/Caller.groovy'], '/tmp/Caller.groovy', 3, 12, 'save', hierarchy)!;
		assert.deepStrictEqual(describeLocations(declarationLocations(target, 'save', hierarchy)), ['/tmp/Foo.groovy:2:9']);
	});

	test('finds the inherited declaration from a call on a subclass', () => {
		const target = findReferenceTarget(files['/tmp/Caller.groovy'], '/tmp/Caller.groovy', 4, 12, 'save', hierarchy)!;
		assert.deepStrictEqual(describeLocations(declarationLocations(target, 'save', hierarchy)), ['/tmp/Foo.groovy:2:9']);
	});
});

suite('resolveUsages — same-named classes in different packages', () => {
	const files: Record<string, string> = {
		'/w/a/Foo.groovy': 'package a\nclass Foo {\n    void save() {}\n    void run() { save() }\n}',
		'/w/b/Foo.groovy': 'package b\nclass Foo {\n    void save() {}\n    void run() { save() }\n}',
		'/w/a/Caller.groovy': 'package a\nclass Caller {\n    def run(Foo foo) {\n        foo.save()\n        Foo.build()\n    }\n}',
		'/w/c/Other.groovy': 'package c\nimport b.Foo\nclass Other {\n    def run(Foo foo) {\n        foo.save()\n        Foo.build()\n    }\n}'
	};
	const index = buildIndex(files);
	const hierarchy = buildHierarchy(files);

	test('keeps method usages to the class the call refers to', () => {
		const resolution = resolveUsages({ kind: 'method', name: 'save', className: 'Foo', classFqn: 'a.Foo' }, index, 'references', hierarchy);
		assert.deepStrictEqual(describe(resolution.records), ['/w/a/Caller.groovy:3', '/w/a/Foo.groovy:3']);
	});

	test('keeps class usages and the files to scan to the class the file refers to', () => {
		const target = findDeclarationTarget(files['/w/b/Foo.groovy'], '/w/b/Foo.groovy', 1, 'Foo')!;
		const resolution = resolveUsages(target, index, 'references', hierarchy);
		assert.deepStrictEqual(describe(resolution.records), ['/w/c/Other.groovy:5']);
		assert.deepStrictEqual(resolution.textScans, [{ scope: 'files', files: ['/w/b/Foo.groovy', '/w/c/Other.groovy'] }]);
	});

	test('resolves super through the hierarchy, following wildcard imports', () => {
		const extra: Record<string, string> = {
			'/w/lib/Base.groovy': 'package lib\nclass Base {\n    void save() {}\n}',
			'/w/app/Base.groovy': 'package app\nclass Base {\n    void save() {}\n}',
			'/w/app2/Child.groovy': 'package app2\nimport lib.*\nclass Child extends Base {\n    void save() { super.save() }\n}'
		};
		const childText = extra['/w/app2/Child.groovy'];
		const target = findReferenceTarget(childText, '/w/app2/Child.groovy', 3, childText.split('\n')[3].lastIndexOf('save'), 'save', buildHierarchy(extra));
		assert.deepStrictEqual(target, { kind: 'method', name: 'save', className: 'Base', classFqn: 'lib.Base' });
	});
});

suite('resolveUsages — enum constants', () => {
	const files: Record<string, string> = {
		'/w/Color.groovy': 'enum Color {\n    RED, BLUE\n    boolean isWarm() { this == RED }\n}',
		'/w/Alert.groovy': 'enum Alert {\n    RED, YELLOW\n}',
		'/w/User.groovy': 'class User {\n    def c = Color.RED\n    def a = Alert.RED\n    def RED = 1\n}'
	};
	const index = buildIndex(files);
	const hierarchy = buildHierarchy(files);
	const scanner = async (word: string, scan: TextScan): Promise<UsageLocation[]> => {
		const paths = scan.scope === 'files' ? scan.files : Object.keys(files);
		return paths.flatMap(sourcePath => findWordMatches(files[sourcePath], word, scan.receiverFieldName)
			.map(match => ({ sourcePath, line: match.line, column: match.column, length: word.length })));
	};
	const describeLocations = (locations: UsageLocation[]) => locations.map(location => `${location.sourcePath}:${location.line}:${location.column}`).sort();

	test('finds Enum.CONSTANT usages and the bare uses inside the enum, not same-named constants of other enums or locals', async () => {
		const colorText = files['/w/Color.groovy'];
		const target = findReferenceTarget(colorText, '/w/Color.groovy', 1, 4, 'RED', hierarchy)!;
		assert.deepStrictEqual(target, { kind: 'constant', name: 'RED', typeName: 'Color', typeFqn: 'Color' });
		const locations = await collectUsageLocations(target, resolveUsages(target, index, 'references', hierarchy), 'references', 'RED', scanner, { sourcePath: '/w/Color.groovy', line: 1, column: 4 });
		assert.deepStrictEqual(describeLocations(locations), ['/w/Color.groovy:2:31', '/w/User.groovy:1:18']);
	});

	test('reads a qualified constant at a usage as a constant of that type', () => {
		const userText = files['/w/User.groovy'];
		assert.deepStrictEqual(findReferenceTarget(userText, '/w/User.groovy', 2, userText.split('\n')[2].indexOf('RED'), 'RED', hierarchy),
			{ kind: 'constant', name: 'RED', typeName: 'Alert', typeFqn: 'Alert' });
	});
});

suite('getters used as properties', () => {
	const files: Record<string, string> = {
		'/w/Invoice.groovy': [
			'class Invoice {',
			'    String code',
			'    String getReceiptCode() {',
			'        return "R-${code}"',
			'    }',
			'    String summary() {',
			'        return this.receiptCode',
			'    }',
			'}'
		].join('\n'),
		'/w/Refund.groovy': 'class Refund {\n    String getReceiptCode() {\n        return "F"\n    }\n}',
		'/w/BillingService.groovy': [
			'class BillingService {',
			'    def run(Invoice invoice, Refund refund, def anything) {',
			'        println invoice.receiptCode',
			'        println refund.receiptCode',
			'        println anything.receiptCode',
			'        println invoice.getReceiptCode()',
			'        invoice.receiptCode = "x"',
			'    }',
			'}'
		].join('\n')
	};
	const index = buildIndex(files);
	const hierarchy = buildHierarchy(files);
	const noWords = async (): Promise<UsageLocation[]> => [];
	const scanProperties = async (scan: PropertyScan): Promise<UsageLocation[]> =>
		scan.files.flatMap(sourcePath => propertyReadLocations(files[sourcePath], sourcePath, scan));
	const describeLocations = (locations: UsageLocation[]) => locations.map(location => `${location.sourcePath}:${location.line}:${location.column}:${location.length}`).sort();
	const getterDeclaration = { sourcePath: '/w/Invoice.groovy', line: 2, column: 11 };

	test('Cmd+Click on the getter lists the explicit call and the property reads of the same class only', async () => {
		const target = findDeclarationTarget(files['/w/Invoice.groovy'], '/w/Invoice.groovy', 2, 'getReceiptCode', 11);
		assert.ok(target);
		const resolution = resolveUsages(target, index, 'navigate', hierarchy);
		const usages = await collectUsageLocations(target, resolution, 'navigate', 'getReceiptCode', noWords, getterDeclaration, scanProperties);
		assert.deepStrictEqual(describeLocations(usages), [
			'/w/BillingService.groovy:2:24:11',
			'/w/BillingService.groovy:5:24:14',
			'/w/Invoice.groovy:6:20:11'
		]);
	});

	test('a getter only read as a property still has usages', async () => {
		const target = findDeclarationTarget(files['/w/Refund.groovy'], '/w/Refund.groovy', 1, 'getReceiptCode', 11);
		assert.ok(target);
		const resolution = resolveUsages(target, index, 'navigate', hierarchy);
		const usages = await collectUsageLocations(target, resolution, 'navigate', 'getReceiptCode', noWords, { sourcePath: '/w/Refund.groovy', line: 1, column: 11 }, scanProperties);
		assert.deepStrictEqual(describeLocations(usages), ['/w/BillingService.groovy:3:23:11']);
	});

	test('Find All References from a property read targets the getter of the receiver type', async () => {
		const service = files['/w/BillingService.groovy'];
		const target = findReferenceTarget(service, '/w/BillingService.groovy', 2, 24, 'receiptCode', hierarchy);
		assert.deepStrictEqual(target, { kind: 'method', name: 'getReceiptCode', className: 'Invoice' });
		const resolution = resolveUsages(target!, index, 'references', hierarchy);
		const usages = await collectUsageLocations(target!, resolution, 'references', 'receiptCode', noWords, undefined, scanProperties);
		assert.deepStrictEqual(describeLocations(usages), [
			'/w/BillingService.groovy:2:24:11',
			'/w/BillingService.groovy:5:24:14',
			'/w/Invoice.groovy:6:20:11'
		]);
		assert.deepStrictEqual(describeLocations(declarationLocations(target!, 'receiptCode', hierarchy)), ['/w/Invoice.groovy:2:11:14']);
	});

	test('Find All References keeps a real field and an untyped receiver out of the getter', () => {
		const service = files['/w/BillingService.groovy'];
		assert.strictEqual(findReferenceTarget(service, '/w/BillingService.groovy', 4, 25, 'receiptCode', hierarchy), undefined);
		const withField = 'class Report {\n    def run(Invoice invoice) {\n        println invoice.code\n    }\n}';
		assert.strictEqual(findReferenceTarget(withField, '/w/Report.groovy', 2, 24, 'code', hierarchy), undefined);
	});
});

suite('getters used as properties — supertype fallback', () => {
	const base = 'class BaseDocument {\n    String getTitle() {\n        return "base"\n    }\n}';
	const child = 'class Contract extends BaseDocument {\n    @Override\n    String getTitle() {\n        return "contract"\n    }\n}';
	const scanFiles = (files: Record<string, string>) => async (scan: PropertyScan): Promise<UsageLocation[]> =>
		scan.files.flatMap(sourcePath => files[sourcePath] ? propertyReadLocations(files[sourcePath], sourcePath, scan) : []);
	const usagesOf = async (files: Record<string, string>) => {
		const index = buildIndex(files);
		const hierarchy = buildHierarchy(files);
		const target = findDeclarationTarget(files['/w/Contract.groovy'], '/w/Contract.groovy', 2, 'getTitle', 11);
		assert.ok(target);
		const resolution = resolveUsages(target, index, 'navigate', hierarchy);
		const usages = await collectUsageLocations(target, resolution, 'navigate', 'getTitle', async () => [], { sourcePath: '/w/Contract.groovy', line: 2, column: 11 }, scanFiles(files));
		return usages.map(location => `${location.sourcePath}:${location.line}`);
	};

	test('an override that nothing calls or reads still falls back to the supertype declaration', async () => {
		assert.deepStrictEqual(await usagesOf({ '/w/BaseDocument.groovy': base, '/w/Contract.groovy': child }), ['/w/BaseDocument.groovy:1']);
	});

	test('an override read as a property lists the read instead of the supertype', async () => {
		const reader = 'class Printer {\n    def print(Contract contract) {\n        println contract.title\n    }\n}';
		assert.deepStrictEqual(
			await usagesOf({ '/w/BaseDocument.groovy': base, '/w/Contract.groovy': child, '/w/Printer.groovy': reader }),
			['/w/Printer.groovy:2']
		);
	});
});

suite('getters used as properties — fields inside the class', () => {
	test('this.field inside the declaring class reads the field, not the getter', async () => {
		const files: Record<string, string> = {
			'/w/Channel.groovy': 'class Channel {\n    String code\n    String getCode() {\n        return code.toUpperCase()\n    }\n    String label() {\n        return this.code\n    }\n}',
			'/w/Panel.groovy': 'class Panel {\n    def show(Channel channel) {\n        println channel.code\n    }\n}'
		};
		const index = buildIndex(files);
		const hierarchy = buildHierarchy(files);
		const target = findDeclarationTarget(files['/w/Channel.groovy'], '/w/Channel.groovy', 2, 'getCode', 11);
		assert.ok(target);
		const resolution = resolveUsages(target, index, 'navigate', hierarchy);
		const scan = async (propertyScan: PropertyScan): Promise<UsageLocation[]> =>
			propertyScan.files.flatMap(sourcePath => propertyReadLocations(files[sourcePath], sourcePath, propertyScan));
		const usages = await collectUsageLocations(target, resolution, 'navigate', 'getCode', async () => [], { sourcePath: '/w/Channel.groovy', line: 2, column: 11 }, scan);
		assert.deepStrictEqual(usages.map(location => `${location.sourcePath}:${location.line}`), ['/w/Panel.groovy:2']);
	});
});
