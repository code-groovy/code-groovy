const GROOVY_KEYWORDS = new Set([
	'abstract', 'as', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class',
	'const', 'continue', 'def', 'default', 'do', 'double', 'else', 'enum', 'extends', 'false',
	'final', 'finally', 'float', 'for', 'goto', 'if', 'implements', 'import', 'in', 'instanceof',
	'int', 'interface', 'long', 'native', 'new', 'null', 'package', 'private', 'protected',
	'public', 'return', 'short', 'static', 'strictfp', 'super', 'switch', 'synchronized',
	'this', 'throw', 'throws', 'trait', 'transient', 'true', 'try', 'void', 'volatile', 'while'
]);

export function isGroovyKeyword(name: string): boolean {
	return GROOVY_KEYWORDS.has(name);
}
