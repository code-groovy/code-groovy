import * as assert from 'assert';
import {
	declaresNoParameters,
	findPropertyReads,
	getterNamesForProperty,
	isPropertyRead,
	propertyNameForGetter,
	propertyReadLocations
} from '../../groovy/property_access_logic';

suite('property_access_logic', () => {
	test('maps getters to property names following the JavaBeans rule', () => {
		assert.strictEqual(propertyNameForGetter('getReceiptCode'), 'receiptCode');
		assert.strictEqual(propertyNameForGetter('isOverdue'), 'overdue');
		assert.strictEqual(propertyNameForGetter('getURL'), 'URL');
		assert.strictEqual(propertyNameForGetter('get'), undefined);
		assert.strictEqual(propertyNameForGetter('getter'), undefined);
		assert.strictEqual(propertyNameForGetter('issue'), undefined);
	});

	test('lists the get and is getters of a property', () => {
		assert.deepStrictEqual(getterNamesForProperty('receiptCode'), ['getReceiptCode', 'isReceiptCode']);
		assert.deepStrictEqual(getterNamesForProperty('URL'), ['getURL', 'isURL']);
	});

	test('tells a property read from a call, an assignment and a method pointer', () => {
		const at = (line: string) => isPropertyRead(line, line.indexOf('code') + 'code'.length);
		assert.strictEqual(at('println invoice.code'), true);
		assert.strictEqual(at('if (invoice.code == "A") {'), true);
		assert.strictEqual(at('invoice.code()'), false);
		assert.strictEqual(at('invoice.code { it }'), false);
		assert.strictEqual(at('invoice.code = "A"'), false);
		assert.strictEqual(at('def pointer = invoice.code.&trim'), true);
	});

	test('checks that a getter is declared without parameters', () => {
		assert.strictEqual(declaresNoParameters('    String getReceiptCode() {', 'getReceiptCode'), true);
		assert.strictEqual(declaresNoParameters('    String getReceiptCode(String prefix) {', 'getReceiptCode'), false);
	});

	test('finds property reads with their receiver type, chain and owner', () => {
		const text = [
			'class BillingService {',
			'    Customer customer',
			'    def run(Invoice invoice, def anything) {',
			'        println invoice.receiptCode',
			'        println invoice?.receiptCode',
			'        println customer.invoice.receiptCode',
			'        println anything.receiptCode',
			'        println this.receiptCode',
			'        invoice.receiptCode = "x"',
			'        invoice.receiptCode()',
			'        println "invoice.receiptCode"',
			'    }',
			'}'
		].join('\n');
		const reads = findPropertyReads(text, '/w/BillingService.groovy', 'receiptCode').map(read => ({
			line: read.line,
			column: read.column,
			receiver: read.receiverName,
			type: read.receiverType,
			root: read.receiverRootType,
			path: read.receiverPath,
			owner: read.ownerClass
		}));
		assert.deepStrictEqual(reads, [
			{ line: 3, column: 24, receiver: 'invoice', type: 'Invoice', root: undefined, path: undefined, owner: 'BillingService' },
			{ line: 4, column: 25, receiver: 'invoice', type: 'Invoice', root: undefined, path: undefined, owner: 'BillingService' },
			{ line: 5, column: 33, receiver: 'invoice', type: undefined, root: 'Customer', path: ['invoice'], owner: 'BillingService' },
			{ line: 6, column: 25, receiver: 'anything', type: undefined, root: undefined, path: undefined, owner: 'BillingService' },
			{ line: 7, column: 21, receiver: 'this', type: undefined, root: undefined, path: undefined, owner: 'BillingService' }
		]);
	});

	test('keeps only the reads a scan accepts, highlighting the property name', () => {
		const text = 'class A {\n    def run(Invoice invoice, Refund refund) {\n        invoice.receiptCode + refund.receiptCode\n    }\n}';
		const locations = propertyReadLocations(text, '/w/A.groovy', {
			scope: 'properties',
			propertyName: 'receiptCode',
			files: ['/w/A.groovy'],
			accepts: read => read.receiverType === 'Invoice'
		});
		assert.deepStrictEqual(locations, [{ sourcePath: '/w/A.groovy', line: 2, column: 16, length: 11 }]);
	});
});
