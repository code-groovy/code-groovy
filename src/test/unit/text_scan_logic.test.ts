import * as assert from 'assert';
import {
	depthsAtLineStarts,
	findWordMatches,
	isImportLine,
	isInsideComment,
	isInsideDocLink,
	lineStartOffsets,
	maskNonCode,
	splitLines
} from '../../groovy/text_scan_logic';

function offsetOf(text: string, needle: string, occurrence = 0): number {
	let index = -1;
	for (let i = 0; i <= occurrence; i++) {
		index = text.indexOf(needle, index + 1);
	}
	return index;
}

suite('isInsideComment', () => {
	test('flags a word inside a line comment', () => {
		const text = 'def run() {\n    // Bank is mentioned only in this comment\n}';
		assert.strictEqual(isInsideComment(text, offsetOf(text, 'Bank')), true);
	});

	test('does not flag code before a trailing comment, but flags the comment part', () => {
		const text = 'Bank.get(1) // Bank again';
		assert.strictEqual(isInsideComment(text, offsetOf(text, 'Bank')), false);
		assert.strictEqual(isInsideComment(text, offsetOf(text, 'Bank', 1)), true);
	});

	test('flags a word inside a multi-line block comment and Groovydoc', () => {
		const text = '/**\n * Loads a Bank by code.\n */\nBank load() {}';
		assert.strictEqual(isInsideComment(text, offsetOf(text, 'Bank')), true);
		assert.strictEqual(isInsideComment(text, offsetOf(text, 'Bank', 1)), false);
	});

	test('does not treat // or /* inside strings as comments', () => {
		const text = 'String url = "http://example.com/*"\nBank bank = Bank.get(1)';
		assert.strictEqual(isInsideComment(text, offsetOf(text, 'Bank')), false);
	});

	test('does not treat // inside a triple-quoted string as a comment', () => {
		const text = 'def sql = """\n    select * from bank // not a comment\n"""\nBank.get(1)';
		assert.strictEqual(isInsideComment(text, offsetOf(text, 'not')), false);
		assert.strictEqual(isInsideComment(text, offsetOf(text, 'Bank')), false);
	});
});

suite('isInsideComment — strings the scanner shares with maskNonCode', () => {
	test('does not end a string early at a quote inside GString interpolation', () => {
		const text = 'def a = "${ "x" } // Bank"\nBank.get(1)';
		assert.strictEqual(isInsideComment(text, offsetOf(text, 'Bank')), false);
		assert.strictEqual(isInsideComment(text, offsetOf(text, 'Bank', 1)), false);
	});

	test('does not open a block comment at /* inside a slashy string', () => {
		const text = 'def pattern = ~/^\\/api\\/*$/\nBank.get(1)\n/* Bank */';
		assert.strictEqual(isInsideComment(text, offsetOf(text, 'Bank')), false);
		assert.strictEqual(isInsideComment(text, offsetOf(text, 'Bank', 1)), true);
	});

	test('still reads division followed by a comment as code', () => {
		const text = 'def ratio = total / count /* Bank */\nBank.get(1)';
		assert.strictEqual(isInsideComment(text, offsetOf(text, 'Bank')), true);
		assert.strictEqual(isInsideComment(text, offsetOf(text, 'Bank', 1)), false);
	});
});

suite('isInsideDocLink', () => {
	test('flags the class name inside {@link ...}', () => {
		const line = ' * Delegates to {@link BankRepository} for lookups';
		assert.strictEqual(isInsideDocLink(line, line.indexOf('BankRepository')), true);
	});

	test('does not flag plain comment text outside the link', () => {
		const line = ' * Delegates to {@link BankRepository} for lookups';
		assert.strictEqual(isInsideDocLink(line, line.indexOf('lookups')), false);
	});
});

suite('isInsideDocLink — @see and @throws', () => {
	test('flags the type named by @see, @throws and @exception, but not the text after it', () => {
		const line = ' * @see PaymentService#save then @throws BusinessException when it fails';
		assert.strictEqual(isInsideDocLink(line, line.indexOf('PaymentService')), true);
		assert.strictEqual(isInsideDocLink(line, line.indexOf('save')), true);
		assert.strictEqual(isInsideDocLink(line, line.indexOf('BusinessException')), true);
		assert.strictEqual(isInsideDocLink(line, line.indexOf('fails')), false);
		assert.strictEqual(isInsideDocLink(' * @exception IOException', 15), true);
	});
});

suite('isImportLine', () => {
	test('matches a plain import statement', () => {
		assert.strictEqual(isImportLine('import com.example.billing.InvoiceSettlementTransaction'), true);
	});

	test('matches an indented import statement', () => {
		assert.strictEqual(isImportLine('    import com.example.Widget'), true);
	});

	test('does not match a line that merely contains the word import', () => {
		assert.strictEqual(isImportLine('def importantValue = 1'), false);
	});

	test('does not match an unrelated line', () => {
		assert.strictEqual(isImportLine('InvoiceSettlementTransaction.where {'), false);
	});
});

suite('maskNonCode', () => {
	test('blanks comments and string contents while keeping offsets and newlines', () => {
		const text = 'a("x") // c\n/* b */ d';
		const masked = maskNonCode(text);
		assert.strictEqual(masked.length, text.length);
		assert.strictEqual(masked, 'a(   )     \n        d');
	});

	test('keeps code inside GString interpolation', () => {
		const masked = maskNonCode('log.info "total: ${widgetService.activate(w)} done"');
		assert.ok(masked.includes('widgetService.activate(w)'));
		assert.ok(!masked.includes('total'));
		assert.ok(!masked.includes('done'));
	});

	test('handles apostrophes and escaped quotes inside strings', () => {
		const masked = maskNonCode(`"don't" + widgetService.activate(w) + 'a\\'' + other.run()`);
		assert.ok(masked.includes('widgetService.activate(w)'));
		assert.ok(masked.includes('other.run()'));
	});
});

suite('maskNonCode — slashy strings', () => {
	test('blanks a slashy regex after ~, = or ( and keeps the code after it', () => {
		const text = 'def a = ~/x\\/*y/\nfoo(/b\\d+/)\nbar()';
		const masked = maskNonCode(text);
		assert.ok(!masked.includes('x'));
		assert.ok(!masked.includes('b\\d'));
		assert.ok(masked.includes('foo('));
		assert.ok(masked.includes('bar()'));
	});

	test('keeps division as code', () => {
		const text = 'def half = total / 2\ndef third = (a + b) / 3';
		assert.strictEqual(maskNonCode(text), text);
	});
});

suite('maskNonCode — slashy openers and dollar-slashy strings', () => {
	test('blanks a dollar-slashy string, keeping its escapes and the code after it', () => {
		const text = 'def g = $/src/*.groovy $$ $/ /$\nfoo()\nbar()';
		const masked = maskNonCode(text);
		assert.ok(!masked.includes('src'));
		assert.ok(masked.includes('foo()') && masked.includes('bar()'));
	});

	test('opens a slashy string after in, case, * and + but not after an operand, a postfix ++ or a line break', () => {
		assert.ok(!maskNonCode('x in /a"b/\nfoo()').includes('a"b'));
		assert.ok(!maskNonCode('switch (x) {\n case /a"b/: foo()\n}').includes('a"b'));
		assert.ok(!maskNonCode('def x = a * /b"c/\nbar()').includes('b"c'));
		assert.ok(!maskNonCode('def x = "a" + /b"c/\nbar()').includes('b"c'));
		for (const text of ['def x = i++ / 2\nfoo("q")', 'def r = total\n    /count\nfoo()', 'def z = 1/\nbar()']) {
			assert.ok(maskNonCode(text).includes('foo(') || maskNonCode(text).includes('bar()'), text);
			assert.ok(maskNonCode(text).includes('/'), text);
		}
	});
});

suite('depthsAtLineStarts', () => {
	test('reports the brace depth at the start of each line', () => {
		const text = 'class A {\n    String name\n    def run() {\n        String local\n    }\n}';
		assert.deepStrictEqual(depthsAtLineStarts(maskNonCode(text)).braces, [0, 1, 1, 2, 2, 1]);
	});

	test('ignores braces inside strings and comments', () => {
		const text = 'class A {\n    String s = "{" // }\n    String t\n}';
		assert.deepStrictEqual(depthsAtLineStarts(maskNonCode(text)).braces, [0, 1, 1, 1]);
	});

	test('reports parenthesis depth and treats CRLF like LF', () => {
		const text = 'def run(String a,\r\n        Long b) {\r\n}';
		assert.deepStrictEqual(depthsAtLineStarts(maskNonCode(text)), { braces: [0, 0, 1], parens: [0, 1, 0] });
	});
});

suite('splitLines and lineStartOffsets', () => {
	test('split on LF, CRLF and a lone CR, with offsets that point at each line start', () => {
		const text = 'a\nbb\r\nccc\rd';
		assert.deepStrictEqual(splitLines(text), ['a', 'bb', 'ccc', 'd']);
		assert.deepStrictEqual(lineStartOffsets(text), [0, 2, 6, 10]);
	});

	test('keeps CR characters of CRLF comments so masked and original lines match', () => {
		const text = '/* a\r\n b */\r\nfoo()';
		assert.deepStrictEqual(splitLines(maskNonCode(text)).length, splitLines(text).length);
		assert.strictEqual(splitLines(maskNonCode(text))[2], 'foo()');
	});
});

suite('findWordMatches', () => {
	const word = 'InvoiceSettlementTransaction';

	test('skips a word inside a // comment', () => {
		assert.deepStrictEqual(findWordMatches(`// ${word} is unused now`, word), []);
	});

	test('finds real code before a trailing comment, but not the comment part', () => {
		assert.deepStrictEqual(findWordMatches(`${word}.where { } // ${word} legacy filter`, word), [{ line: 0, column: 0 }]);
	});

	test('skips a word inside a string literal, including after //', () => {
		assert.deepStrictEqual(findWordMatches(`String url = "http://example.com/${word}"`, word), []);
	});

	test('finds a word inside GString interpolation', () => {
		const text = `log.info "found \${${word}.count()}"`;
		assert.deepStrictEqual(findWordMatches(text, word), [{ line: 0, column: text.indexOf(`${word}.count`) }]);
	});

	test('skips import lines', () => {
		assert.deepStrictEqual(findWordMatches(`import com.example.${word}\n${word}.get(1)`, word), [{ line: 1, column: 0 }]);
	});

	test('scopes by receiver, accepting safe navigation', () => {
		const text = 'widgetService.save(w)\nwidgetService?.save(w)\norder.save()';
		assert.deepStrictEqual(findWordMatches(text, 'save', 'widgetService').map(match => match.line), [0, 1]);
	});
});
