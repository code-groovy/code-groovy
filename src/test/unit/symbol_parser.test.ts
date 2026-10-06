import * as assert from 'assert';
import { parseDocumentSymbols } from '../../groovy/symbol_parser';

suite('parseDocumentSymbols — masked source', () => {
	test('ignores declarations inside strings and reads qualified or generic supertypes', () => {
		const text = [
			'class Report extends com.acme.BaseReport<Map<String, Long>> implements Serializable, java.io.Closeable {',
			'    String sql = """',
			'        SELECT SUM(value)',
			'        class Fake {',
			'    """',
			'    void close() {',
			'    }',
			'}'
		].join('\n');
		const symbols = parseDocumentSymbols(text, '/tmp/Report.groovy');
		assert.deepStrictEqual(symbols.classes.map(cls => cls.simpleName), ['Report']);
		assert.deepStrictEqual(symbols.methods.map(method => `${method.name}@${method.classFqn}`), ['close@Report']);
		assert.deepStrictEqual(symbols.classes[0].extendsTypes, ['com.acme.BaseReport']);
		assert.deepStrictEqual(symbols.classes[0].implementsTypes, ['Serializable', 'java.io.Closeable']);
	});
});

suite('parseDocumentSymbols — modifiers', () => {
	test('recognizes a declaration with only static and synchronized modifiers', () => {
		const symbols = parseDocumentSymbols('class Holder {\n    public static synchronized getInstance() {\n    }\n}', '/tmp/Holder.groovy');
		assert.deepStrictEqual(symbols.methods.map(method => method.name), ['getInstance']);
	});
});

suite('parseDocumentSymbols — enums', () => {
	test('reads annotated constants, constants on the enum line and constants with bodies', () => {
		const text = [
			'enum Status {',
			'    @Deprecated PENDING,',
			'    @Deprecated',
			'    CREDITED(1, "a,b"),',
			'    REFUNDED {',
			'        String label() { "x" }',
			'    }',
			'    Status() {}',
			'    Status(Integer code, String name) {}',
			'}',
			'enum Kind { A, B }'
		].join('\n');
		const symbols = parseDocumentSymbols(text, '/tmp/Status.groovy');
		assert.deepStrictEqual(symbols.enumConstants.map(constant => `${constant.name}@${constant.line}:${constant.argumentCount}`), [
			'PENDING@1:0', 'CREDITED@3:2', 'REFUNDED@4:0', 'A@10:0', 'B@10:0'
		]);
		assert.deepStrictEqual(symbols.constructors.map(constructor => `${constructor.line}:${constructor.parameterCount}`), ['7:0', '8:2']);
	});
});

suite('parseDocumentSymbols — enum constants with bodies and closures', () => {
	test('keeps reading constants after a constant body that closes on the same line', () => {
		const text = [
			'enum Op {',
			'    PLUS { int apply() { 1 } },',
			'    MINUS { int apply() { 2 } }',
			'    abstract int apply()',
			'}'
		].join('\n');
		assert.deepStrictEqual(parseDocumentSymbols(text, '/tmp/Op.groovy').enumConstants.map(constant => constant.name), ['PLUS', 'MINUS']);
	});

	test('keeps reading constants after a closure argument', () => {
		const text = [
			'enum Rule {',
			'    PAID({ it > 0 }),',
			'    OPEN({ it == 0 })',
			'    Rule(Closure check) {}',
			'}'
		].join('\n');
		assert.deepStrictEqual(parseDocumentSymbols(text, '/tmp/Rule.groovy').enumConstants.map(constant => constant.name), ['PAID', 'OPEN']);
	});

	test('stops at the closing brace of a one-line enum with a constant body', () => {
		const text = 'enum Mode { ON { String label() { "on" } }, OFF }\nclass After {}';
		assert.deepStrictEqual(parseDocumentSymbols(text, '/tmp/Mode.groovy').enumConstants.map(constant => constant.name), ['ON', 'OFF']);
	});
});

suite('parseDocumentSymbols — constructors without modifiers', () => {
	test('records a constructor with no modifier and keeps it out of the methods', () => {
		const text = [
			'enum WidgetKind {',
			'    A("a")',
			'    final String code',
			'    WidgetKind(String code) {',
			'        this.code = code',
			'    }',
			'}'
		].join('\n');
		const symbols = parseDocumentSymbols(text, '/tmp/WidgetKind.groovy');
		assert.deepStrictEqual(symbols.constructors.map(constructor => `${constructor.line}:${constructor.column}:${constructor.parameterCount}`), ['3:4:1']);
		assert.deepStrictEqual(symbols.methods, []);
	});
});

suite('parseDocumentSymbols — class members and nested types', () => {
	test('marks only fields at the class body level as class members, including after a nested type', () => {
		const text = [
			'class Outer {',
			'    String name',
			'    static class Inner {',
			'        Long code',
			'    }',
			'    void run() {',
			'        String local = "x"',
			'    }',
			'    Integer total',
			'}'
		].join('\n');
		const fields = parseDocumentSymbols(text, '/tmp/Outer.groovy').fields;
		assert.deepStrictEqual(fields.map(field => `${field.name}@${field.classFqn}:${field.classMember}`), [
			'name@Outer:true', 'code@Outer.Inner:true', 'local@Outer:false', 'total@Outer:true'
		]);
	});

	test('ends a nested type at its own closing brace and the outer type at the last one', () => {
		const text = [
			'class Outer {',
			'    static class Inner {',
			'        void a() {',
			'        }',
			'    }',
			'    void b() {}',
			'}'
		].join('\n');
		const classes = parseDocumentSymbols(text, '/tmp/Outer.groovy').classes;
		assert.deepStrictEqual(classes.map(cls => `${cls.simpleName}:${cls.line}-${cls.endLine}`), ['Outer:0-6', 'Inner:1-4']);
	});
});

suite('parseDocumentSymbols — very long lines', () => {
	test('skips a huge generated line quickly and keeps parsing the declarations after it', () => {
		const text = `class Generated${'<'.repeat(20000)}\nclass Real {\n    void run() {}\n}`;
		const started = Date.now();
		const symbols = parseDocumentSymbols(text, '/tmp/Generated.groovy');
		assert.ok(Date.now() - started < 1000);
		assert.deepStrictEqual(symbols.classes.map(cls => cls.simpleName), ['Real']);
		assert.deepStrictEqual(symbols.methods.map(method => method.name), ['run']);
	});
});

suite('parseDocumentSymbols — declarations the parser used to miss', () => {
	test('reads generic methods and qualified or default return types', () => {
		const text = [
			'class PaginationDTO<T> {',
			'    public static <T> PaginationDTO<T> create(List<T> list) { null }',
			'    java.util.Map build() { [:] }',
			'    default void describe() {}',
			'}'
		].join('\n');
		const methods = parseDocumentSymbols(text, '/tmp/PaginationDTO.groovy').methods;
		assert.deepStrictEqual(methods.map(method => `${method.name}@${method.line}:${method.column}`), ['create@1:39', 'build@2:18', 'describe@3:17']);
	});

	test('takes the column of the declared name, not of an earlier match inside a modifier', () => {
		const text = 'class Crypter {\n\tprivate byte[] iv(String iv64 = null) { null }\n}';
		const [method] = parseDocumentSymbols(text, '/tmp/Crypter.groovy').methods;
		assert.deepStrictEqual([method.name, method.line, method.column], ['iv', 1, 16]);
	});

	test('reads a class header split across lines and a class with an annotation on the same line', () => {
		const text = [
			'class Foo extends Bar',
			'        implements Baz,',
			'            Qux {',
			'}',
			'@CompileStatic class Other extends Base {',
			'}'
		].join('\n');
		const classes = parseDocumentSymbols(text, '/tmp/Foo.groovy').classes;
		assert.deepStrictEqual(classes.map(cls => [cls.simpleName, cls.line, cls.endLine, cls.extendsTypes, cls.implementsTypes]), [
			['Foo', 0, 3, ['Bar'], ['Baz', 'Qux']],
			['Other', 4, 5, ['Base'], []]
		]);
	});

	test('reads a member declared on the same line as a one-line class or after the constants of a one-line enum', () => {
		const text = 'class A { void x() {} }\nenum Color { RED, GREEN; int code() { 1 } }';
		const symbols = parseDocumentSymbols(text, '/tmp/A.groovy');
		assert.deepStrictEqual(symbols.methods.map(method => `${method.name}@${method.classFqn}`), ['x@A', 'code@Color']);
		assert.deepStrictEqual(symbols.enumConstants.map(constant => constant.name), ['RED', 'GREEN']);
	});

	test('does not treat local variables of a script as class members', () => {
		const text = 'def run() {\n    Foo local = build()\n    local.go()\n}';
		assert.deepStrictEqual(parseDocumentSymbols(text, '/tmp/script.groovy').fields.map(field => `${field.name}:${field.classMember}`), ['local:false']);
	});

	test('reads non-ASCII class names and names nested types after their outer type', () => {
		const text = 'package a\nclass Ação {\n    enum Status { OPEN }\n}';
		assert.deepStrictEqual(parseDocumentSymbols(text, '/tmp/Acao.groovy').classes.map(cls => cls.fqn), ['a.Ação', 'a.Ação.Status']);
	});

	test('keeps constructors with modifiers out of the methods', () => {
		const text = 'class Widget {\n    public Widget(String name) {}\n    private Widget() {}\n    void run() {}\n}';
		const symbols = parseDocumentSymbols(text, '/tmp/Widget.groovy');
		assert.deepStrictEqual(symbols.methods.map(method => method.name), ['run']);
		assert.deepStrictEqual(symbols.constructors.map(constructor => `${constructor.line}:${constructor.column}`), ['1:11', '2:12']);
	});
});
