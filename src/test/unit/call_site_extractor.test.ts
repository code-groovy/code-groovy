import * as assert from 'assert';
import { analyzeSource, excludeDeclarationCallSites, receiverAt, receiverBefore, receiverChain, resolveChainRootType, resolveReceiverType } from '../../groovy/call_site_extractor';
import { ParsedMethod, parseDocumentSymbols } from '../../groovy/symbol_parser';

suite('call_site_extractor', () => {
	test('extracts a qualified call with its receiver', () => {
		const text = 'invoiceSettlementService.updateStatusInBatch(idList)';
		const records = analyzeSource(text, '/tmp/Widget.groovy').callSites;
		assert.strictEqual(records.length, 1);
		assert.strictEqual(records[0].methodName, 'updateStatusInBatch');
		assert.strictEqual(records[0].receiverName, 'invoiceSettlementService');
		assert.strictEqual(records[0].line, 0);
		assert.strictEqual(records[0].column, text.indexOf('updateStatusInBatch'));
	});

	test('extracts an unqualified call with no receiver', () => {
		const text = 'validateProfileUpdate(customerId, params)';
		const records = analyzeSource(text, '/tmp/Widget.groovy').callSites;
		assert.strictEqual(records.length, 1);
		assert.strictEqual(records[0].methodName, 'validateProfileUpdate');
		assert.strictEqual(records[0].receiverName, undefined);
	});

	test('tolerates whitespace around the dot', () => {
		const text = '   invoiceSettlementService  .  updateStatusInBatch(x)';
		const records = analyzeSource(text, '/tmp/Widget.groovy').callSites;
		assert.strictEqual(records.length, 1);
		assert.strictEqual(records[0].receiverName, 'invoiceSettlementService');
		assert.strictEqual(records[0].column, text.indexOf('updateStatusInBatch'));
	});

	test('skips calls inside string literals', () => {
		const text = '[logErrorMessage: "WidgetService.save >> failed to update"]';
		const records = analyzeSource(text, '/tmp/Widget.groovy').callSites;
		assert.strictEqual(records.length, 0);
	});

	test('finds multiple call sites across lines', () => {
		const text = [
			'widgetService.updateStatusInBatch(webhookProcessedIdList, WebhookRequestStatus.PROCESSED)',
			'widgetService.updateStatusInBatch(webhookErrorIdList, WebhookRequestStatus.ERROR)'
		].join('\n');
		const records = analyzeSource(text, '/tmp/Widget.groovy').callSites;
		assert.strictEqual(records.length, 2);
		assert.strictEqual(records[0].line, 0);
		assert.strictEqual(records[1].line, 1);
	});

	test('does not choke on lines with unmatched parentheses', () => {
		const text = 'def x = (1 + 2)';
		const records = analyzeSource(text, '/tmp/Widget.groovy').callSites;
		assert.strictEqual(records.length, 0);
	});

	test('a method declaration is itself extracted as a call site with no receiver', () => {
		const text = 'public void updateItemAsPaid(InvoiceSettlement settlementItem) {';
		const records = analyzeSource(text, '/tmp/Widget.groovy').callSites;
		assert.strictEqual(records.length, 1);
		assert.strictEqual(records[0].methodName, 'updateItemAsPaid');
		assert.strictEqual(records[0].receiverName, undefined);
	});

	test('extracts a receiver-qualified call using paren-less closure syntax', () => {
		const text = 'exists InvoiceSettlementTransaction.where {';
		const records = analyzeSource(text, '/tmp/Widget.groovy').callSites;
		assert.strictEqual(records.length, 1);
		assert.strictEqual(records[0].methodName, 'where');
		assert.strictEqual(records[0].receiverName, 'InvoiceSettlementTransaction');
	});

	test('ignores a bare identifier followed by { with no receiver', () => {
		const cases = ['} else {', 'try {', 'finally {', 'class Widget {'];
		for (const text of cases) {
			const records = analyzeSource(text, '/tmp/Widget.groovy').callSites;
			assert.strictEqual(records.length, 0, `expected no records for: ${text}`);
		}
	});

	test('keeps the receiver of a safe-navigation call', () => {
		const text = 'widgetService?.save(widget)';
		const records = analyzeSource(text, '/tmp/Widget.groovy').callSites;
		assert.strictEqual(records.length, 1);
		assert.strictEqual(records[0].methodName, 'save');
		assert.strictEqual(records[0].receiverName, 'widgetService');
		assert.strictEqual(records[0].column, text.indexOf('save'));
	});

	test('keeps the receiver of a spread call', () => {
		const records = analyzeSource('widgets*.rename(value)', '/tmp/Widget.groovy').callSites;
		assert.strictEqual(records.length, 1);
		assert.strictEqual(records[0].methodName, 'rename');
		assert.strictEqual(records[0].receiverName, 'widgets');
	});

	test('does not index calls inside comments or Groovydoc', () => {
		const text = [
			'// widgetService.activate(w)',
			'/* widgetService.activate(w) */',
			'/**',
			' * Calls widgetService.activate(w)',
			' */'
		].join('\n');
		assert.deepStrictEqual(analyzeSource(text, '/tmp/Widget.groovy').callSites, []);
	});

	test('indexes calls inside GString interpolation and after strings with apostrophes', () => {
		const text = [
			'log.info "total: ${widgetService.activate(w)}"',
			`"don't" + widgetService.activate(w)`
		].join('\n');
		const records = analyzeSource(text, '/tmp/Widget.groovy').callSites.filter(record => record.methodName === 'activate');
		assert.deepStrictEqual(records.map(record => `${record.receiverName}@${record.line}`), ['widgetService@0', 'widgetService@1']);
	});

	test('records the declared type of a typed receiver, using the nearest declaration', () => {
		const text = [
			'def first(Order item) {',
			'    item.save()',
			'}',
			'def second(Widget item) {',
			'    item.save()',
			'    def other = new Widget()',
			'    other.save()',
			'}'
		].join('\n');
		const saves = analyzeSource(text, '/tmp/Widget.groovy').callSites.filter(record => record.methodName === 'save');
		assert.deepStrictEqual(saves.map(record => record.receiverType), ['Order', 'Widget', 'Widget']);
	});

	test('limits a declared receiver type to the enclosing method', () => {
		const text = [
			'class Caller {',
			'    def first(Customer entity) {',
			'        entity.confirm()',
			'    }',
			'    def second() {',
			'        def entity = Payment.get(1)',
			'        entity.confirm()',
			'    }',
			'    def third() {',
			'        entity.confirm()',
			'    }',
			'}'
		].join('\n');
		const confirms = analyzeSource(text, '/tmp/Caller.groovy').callSites.filter(record => record.methodName === 'confirm');
		assert.deepStrictEqual(confirms.map(record => record.receiverType), ['Customer', 'Payment', undefined]);
	});

	test('records the type of for-in and for-colon loop variables', () => {
		const text = [
			'def run(List items) {',
			'    for (Payment payment in items) {',
			'        payment.confirm()',
			'    }',
			'    for (Customer customer : items) {',
			'        customer.confirm()',
			'    }',
			'}'
		].join('\n');
		const confirms = analyzeSource(text, '/tmp/Caller.groovy').callSites.filter(record => record.methodName === 'confirm');
		assert.deepStrictEqual(confirms.map(record => record.receiverType), ['Payment', 'Customer']);
	});

	test('keeps parameter types from multi-line signatures and Allman braces', () => {
		const text = [
			'class Caller {',
			'    Payment payer',
			'    void run(Customer payer,',
			'            Boolean flag) {',
			'        payer.save()',
			'    }',
			'    void other(Order order)',
			'    {',
			'        order.save()',
			'    }',
			'}'
		].join('\n');
		const saves = analyzeSource(text, '/tmp/Caller.groovy').callSites.filter(record => record.methodName === 'save');
		assert.deepStrictEqual(saves.map(record => record.receiverType), ['Customer', 'Order']);
	});

	test('does not treat a parameter on its own line as a class field', () => {
		const text = [
			'class Caller {',
			'    void a(Long id,',
			'           Payment item',
			'    ) {',
			'    }',
			'    void b(item) {',
			'        item.save()',
			'    }',
			'    static class Inner {',
			'        def paymentService',
			'        void c() {',
			'            paymentService.pay()',
			'        }',
			'    }',
			'}'
		].join('\n');
		const records = analyzeSource(text, '/tmp/Caller.groovy').callSites;
		assert.strictEqual(records.find(record => record.methodName === 'save')?.receiverType, undefined);
		assert.strictEqual(records.find(record => record.methodName === 'pay')?.receiverType, 'PaymentService');
	});

	test('an untyped def or closure parameter hides an earlier typed declaration', () => {
		const text = [
			'def run(Customer entity) {',
			'    def other = build()',
			'    Customer other2 = null',
			'    list.each { other2 -> other2.confirm() }',
			'}'
		].join('\n');
		const confirm = analyzeSource(text, '/tmp/Caller.groovy').callSites.find(record => record.methodName === 'confirm');
		assert.strictEqual(confirm?.receiverType, undefined);
		assert.strictEqual(resolveReceiverType(text, 1, 'other'), undefined);
	});

	test('uses the type of a class-level field declared after the method', () => {
		const text = [
			'class Caller {',
			'    def run() {',
			'        gateway.send()',
			'    }',
			'    PaymentGateway gateway',
			'}'
		].join('\n');
		assert.strictEqual(analyzeSource(text, '/tmp/Caller.groovy').callSites.find(record => record.methodName === 'send')?.receiverType, 'PaymentGateway');
	});

	test('marks the end of a call chain with an opaque receiver instead of no receiver', () => {
		const text = [
			'Payment.findAll().confirm()',
			'items[0].confirm()',
			'order.customer.confirm()'
		].join('\n');
		const confirms = analyzeSource(text, '/tmp/Customer.groovy').callSites.filter(record => record.methodName === 'confirm');
		assert.deepStrictEqual(confirms.map(record => record.receiverKind ?? record.receiverName), ['chain', 'chain', 'customer']);
	});

	test('keeps the receiver of a call continued on the next line', () => {
		const text = ['paymentService', '    .process(2)', 'paymentService?.', '    process(3)'].join('\n');
		const records = analyzeSource(text, '/tmp/Caller.groovy').callSites.filter(record => record.methodName === 'process');
		assert.deepStrictEqual(records.map(record => `${record.receiverName}@${record.line}`), ['paymentService@1', 'paymentService@3']);
	});

	test('records the owning class, going back to the outer class after a nested type', () => {
		const text = [
			'class PaymentService {',
			'    static enum Kind { A, B }',
			'    def process() {',
			'        helper()',
			'    }',
			'    static class Item {',
			'        def touch() { helper() }',
			'    }',
			'    def helper() {}',
			'}'
		].join('\n');
		const helpers = analyzeSource(text, '/tmp/PaymentService.groovy').callSites.filter(record => record.methodName === 'helper' && record.line !== 8);
		assert.deepStrictEqual(helpers.map(record => `${record.ownerClass}@${record.line}`), ['PaymentService@3', 'PaymentService.Item@6']);
	});

	test('records the root type and path of a receiver chain instead of typing its last segment', () => {
		const text = [
			'class Caller {',
			'    def run(Order order, Customer status) {',
			'        order.status?.isFinished()',
			'        Status.PAID.isFinished()',
			'        this.order.buyer.isFinished()',
			'        foo().status.isFinished()',
			'    }',
			'}'
		].join('\n');
		const records = analyzeSource(text, '/tmp/Caller.groovy').callSites.filter(record => record.methodName === 'isFinished');
		assert.deepStrictEqual(records.map(record => [record.receiverRootType, record.receiverPath, record.receiverType]), [
			['Order', ['status'], undefined],
			['Status', ['PAID'], undefined],
			['Caller', ['order', 'buyer'], undefined],
			[undefined, undefined, undefined]
		]);
	});

	test('does not index control-flow keywords as calls', () => {
		const cases = ['if (x) {', 'for (item in list) {', 'while (running) {', 'switch (kind) {', '} catch (Exception e) {', 'return (a + b)'];
		for (const text of cases) {
			const records = analyzeSource(text, '/tmp/Widget.groovy').callSites;
			assert.deepStrictEqual(records.map(record => record.methodName), [], `expected no records for: ${text}`);
		}
	});
});

suite('excludeDeclarationCallSites', () => {
	test('removes the call site that matches a method declaration', () => {
		const text = 'public void updateItemAsPaid(InvoiceSettlement settlementItem) {';
		const callSites = analyzeSource(text, '/tmp/Widget.groovy').callSites;
		const methods: ParsedMethod[] = [
			{ name: 'updateItemAsPaid', line: 0, column: text.indexOf('updateItemAsPaid'), classFqn: 'Widget', sourcePath: '/tmp/Widget.groovy' }
		];
		const filtered = excludeDeclarationCallSites(callSites, methods);
		assert.strictEqual(filtered.length, 0);
	});

	test('keeps a real call site with a receiver even if the method name matches a declaration', () => {
		const text = 'partnerSettlement.updateItemAsPaid(settlementItem)';
		const callSites = analyzeSource(text, '/tmp/Widget.groovy').callSites;
		const methods: ParsedMethod[] = [
			{ name: 'updateItemAsPaid', line: 0, column: text.indexOf('updateItemAsPaid'), classFqn: 'Widget', sourcePath: '/tmp/Widget.groovy' }
		];
		const filtered = excludeDeclarationCallSites(callSites, methods);
		assert.strictEqual(filtered.length, 1);
	});

	test('keeps a same-line recursive call while removing only the declaration itself', () => {
		const text = 'def fib(n) { return n <= 1 ? n : fib(n) }';
		const callSites = analyzeSource(text, '/tmp/Widget.groovy').callSites;
		const methods: ParsedMethod[] = [
			{ name: 'fib', line: 0, column: text.indexOf('fib'), classFqn: 'Widget', sourcePath: '/tmp/Widget.groovy' }
		];
		const filtered = excludeDeclarationCallSites(callSites, methods);
		assert.strictEqual(filtered.length, 1);
		assert.strictEqual(filtered[0].column, text.lastIndexOf('fib'));
	});

	test('removes declarations with generic/array return types and same-line annotations', () => {
		const text = [
			'class WidgetService {',
			'    Map<String, List<Widget>> groupByName(Long id) {',
			'    String[] names() {',
			'    @Transactional(readOnly = true) def load() {',
			'}'
		].join('\n');
		const sourcePath = '/tmp/WidgetService.groovy';
		const methods = parseDocumentSymbols(text, sourcePath).methods;
		const filtered = excludeDeclarationCallSites(analyzeSource(text, sourcePath).callSites, methods);
		assert.deepStrictEqual(filtered.map(record => record.methodName), []);
	});

	test('keeps a call after return, which is not a declaration', () => {
		const text = [
			'class WidgetService {',
			'    def build() {',
			'        return rename(value)',
			'    }',
			'}'
		].join('\n');
		const sourcePath = '/tmp/WidgetService.groovy';
		const methods = parseDocumentSymbols(text, sourcePath).methods;
		const filtered = excludeDeclarationCallSites(analyzeSource(text, sourcePath).callSites, methods);
		assert.deepStrictEqual(filtered.map(record => `${record.methodName}@${record.line}`), ['rename@2']);
	});

	test('keeps unrelated calls in other files untouched', () => {
		const text = 'validateProfileUpdate(customerId, params)';
		const callSites = analyzeSource(text, '/tmp/Other.groovy').callSites;
		const methods: ParsedMethod[] = [];
		const filtered = excludeDeclarationCallSites(callSites, methods);
		assert.strictEqual(filtered.length, 1);
	});
});

suite('resolveChainRootType', () => {
	const text = [
		'class First {',
		'    Customer order',
		'}',
		'class Second {',
		'    Order order',
		'    def run(Payment payment) {',
		'        this.order.status.isFinished()',
		'        payment.customer.save()',
		'    }',
		'}'
	].join('\n');

	test('types this with the class that owns the line, not the first class of the file', () => {
		assert.strictEqual(resolveChainRootType(text, 6, 'this', '/tmp/Second.groovy'), 'Second');
	});

	test('types a variable root through its declaration and keeps a capitalized root as is', () => {
		assert.strictEqual(resolveChainRootType(text, 7, 'payment', '/tmp/Second.groovy'), 'Payment');
		assert.strictEqual(resolveChainRootType(text, 7, 'Status', '/tmp/Second.groovy'), 'Status');
	});

	test('matches the root type the index records for the same chain', () => {
		const record = analyzeSource(text, '/tmp/Second.groovy').callSites.find(callSite => callSite.methodName === 'isFinished');
		assert.strictEqual(record?.receiverRootType, 'Second');
		assert.deepStrictEqual(record?.receiverPath, ['order', 'status']);
	});
});

suite('analyzeSource — calls the extractor used to misread', () => {
	const calls = (text: string) => analyzeSource(text, '/tmp/Caller.groovy').callSites.map(record => `${record.receiverName ?? '-'}.${record.methodName}`);

	test('indexes method pointers as calls on their receiver', () => {
		assert.deepStrictEqual(calls('def run() {\n    items.each(widgetService.&rename)\n}').filter(call => call.endsWith('rename')), ['widgetService.rename']);
	});

	test('treats a qualified constructor call as a call of the class', () => {
		assert.deepStrictEqual(calls('def w = new com.acme.Widget()'), ['-.Widget']);
	});

	test('keeps a call after a direct field access and a URL mapping call with a string argument', () => {
		assert.deepStrictEqual(calls('items[0].@attributes.keySet()\nget "/bills"(controller: "bill")'), ['attributes.keySet', '-.get']);
	});

	test('skips annotations with dotted names and Spock feature names', () => {
		const text = '@groovy.transform.TypeChecked(extensions = "x")\nclass Spec {\n    def "creates a widget"() {\n        String "other"()\n    }\n}';
		assert.deepStrictEqual(calls(text), []);
	});

	test('types variables declared with var, a qualified new and a second declarator', () => {
		const text = [
			'class Caller {',
			'    def run() {',
			'        var first = new com.acme.Widget()',
			'        Widget a = build(), b = other()',
			'        first.save()',
			'        b.save()',
			'    }',
			'}'
		].join('\n');
		const saves = analyzeSource(text, '/tmp/Caller.groovy').callSites.filter(record => record.methodName === 'save');
		assert.deepStrictEqual(saves.map(record => record.receiverType), ['Widget', 'Widget']);
	});

	test('does not type an untyped parameter after a typed one', () => {
		const text = 'class Caller {\n    def run(Order order, status) {\n        status.save()\n    }\n}';
		assert.strictEqual(analyzeSource(text, '/tmp/Caller.groovy').callSites.find(record => record.methodName === 'save')?.receiverType, undefined);
	});
});

suite('receiverBefore, receiverChain and receiverAt', () => {
	const at = (text: string, word: string) => text.indexOf(word);

	test('reads the receiver before a dot, on the same or the previous line', () => {
		const text = 'fooService\n    .findType(1)\nbar?.run()';
		assert.deepStrictEqual(receiverBefore(text, at(text, 'findType')), { kind: 'name', name: 'fooService', offset: 0 });
		assert.deepStrictEqual(receiverBefore(text, at(text, 'run')), { kind: 'name', name: 'bar', offset: at(text, 'bar') });
		assert.strictEqual(receiverBefore(text, 0), undefined);
	});

	test('reads the segments of a property chain and marks a chain after a call as opaque', () => {
		const text = 'order.buyer?.address.format()\nfind().first.name()';
		assert.deepStrictEqual(receiverChain(text, at(text, 'address'), 'address'), ['order', 'buyer', 'address']);
		assert.deepStrictEqual(receiverAt(text, at(text, 'format')), { kind: 'name', name: 'address', chain: ['order', 'buyer', 'address'] });
		assert.deepStrictEqual(receiverAt(text, at(text, 'name()')), { kind: 'opaque' });
		assert.deepStrictEqual(receiverAt(text, 0), { kind: 'none' });
	});
});

suite('analyzeSource and parseDocumentSymbols — Java sources', () => {
	const text = [
		'package a;',
		'import b.K;',
		'public class J extends K implements L {',
		'    private final Service service;',
		'    public J(Service service) { this.service = service; }',
		'    public static void main(String[] args) {',
		'        new J(null).service.run();',
		'        K.helper(args);',
		'    }',
		'}'
	].join('\n');

	test('reads the class, constructor, method and calls of a Java file', () => {
		const symbols = parseDocumentSymbols(text, '/tmp/J.java');
		assert.deepStrictEqual(symbols.classes.map(cls => [cls.fqn, cls.extendsTypes, cls.implementsTypes]), [['a.J', ['K'], ['L']]]);
		assert.deepStrictEqual(symbols.methods.map(method => method.name), ['main']);
		assert.deepStrictEqual(symbols.constructors.map(constructor => constructor.line), [4]);
		const calls = analyzeSource(text, '/tmp/J.java').callSites.map(record => `${record.receiverKind ?? record.receiverName ?? '-'}.${record.methodName}`);
		assert.deepStrictEqual(calls.filter(call => call.endsWith('run') || call.endsWith('helper')), ['service.run', 'K.helper']);
	});
});
