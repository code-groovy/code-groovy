import * as assert from 'assert';
import { CallSiteIndexStore } from '../../groovy/call_site_index_store';
import { CallSiteRecord } from '../../groovy/call_site_extractor';

function record(methodName: string, receiverName?: string): CallSiteRecord {
	return { methodName, receiverName, sourcePath: '/tmp/Widget.groovy', line: 0, column: 0 };
}

suite('call_site_index_store', () => {
	test('is not ready before add() has been called', () => {
		const store = new CallSiteIndexStore();
		assert.strictEqual(store.isReady(), false);
	});

	test('becomes ready after add(), even with zero records', () => {
		const store = new CallSiteIndexStore();
		store.add([]);
		assert.strictEqual(store.isReady(), true);
	});

	test('stays ready after clear()', () => {
		const store = new CallSiteIndexStore();
		store.add([record('foo')]);
		store.clear();
		assert.strictEqual(store.isReady(), true);
	});

	test('lookup returns every call with that method name', () => {
		const store = new CallSiteIndexStore();
		store.add([record('save', 'partnerSettlement'), record('save', 'otherService')]);
		assert.strictEqual(store.lookup('save').length, 2);
	});

	test('lookupByReceiver finds every call made on that receiver, regardless of method name', () => {
		const store = new CallSiteIndexStore();
		store.add([
			record('where', 'InvoiceSettlementTransaction'),
			record('createCriteria', 'InvoiceSettlementTransaction'),
			record('save', 'otherService')
		]);
		const usages = store.lookupByReceiver('InvoiceSettlementTransaction');
		assert.strictEqual(usages.length, 2);
		assert.deepStrictEqual(usages.map(u => u.methodName).sort(), ['createCriteria', 'where']);
	});

	test('lookupByReceiver ignores calls with no receiver', () => {
		const store = new CallSiteIndexStore();
		store.add([record('validateProfileUpdate')]);
		assert.strictEqual(store.lookupByReceiver('validateProfileUpdate').length, 0);
	});

	test('lookupByReceiver is empty after clear()', () => {
		const store = new CallSiteIndexStore();
		store.add([record('where', 'Widget')]);
		store.clear();
		assert.strictEqual(store.lookupByReceiver('Widget').length, 0);
	});
});
