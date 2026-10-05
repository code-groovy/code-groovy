import * as assert from 'assert';
import {
	collectGrailsImplicitsFromTree,
	collectInlineValueSpecs,
	findEvaluatableExpression,
	findNamedVariable,
	isUsefulEvalResult,
	javaBeanGetter,
	javaEvaluateExpressions,
	isMissingJavaProjectError,
	isPurePropertyPath,
	resolveVariablePath,
	rewriteGroovyEvaluate,
	splitPropertyPath
} from '../../debug/groovy_debug_eval_logic';

suite('groovy_debug_eval_logic', () => {
	test('rewrites Grails implicits to Java getters', () => {
		assert.strictEqual(rewriteGroovyEvaluate('params'), 'getParams()');
		assert.strictEqual(rewriteGroovyEvaluate('session'), 'getSession()');
		assert.strictEqual(rewriteGroovyEvaluate('request'), 'getRequest()');
		assert.strictEqual(rewriteGroovyEvaluate('flash'), 'getFlash()');
	});

	test('rewrites params and flash as map get', () => {
		assert.strictEqual(rewriteGroovyEvaluate('params.id'), 'getParams().get("id")');
		assert.strictEqual(rewriteGroovyEvaluate("params['name']"), 'getParams().get(\'name\')');
		assert.strictEqual(rewriteGroovyEvaluate('flash.message'), 'getFlash().get("message")');
	});

	test('rewrites session attributes and bean properties', () => {
		assert.strictEqual(rewriteGroovyEvaluate('session.user'), 'getSession().getAttribute("user")');
		assert.strictEqual(rewriteGroovyEvaluate('user.name'), 'user.getName()');
		assert.strictEqual(rewriteGroovyEvaluate('this.params'), 'this.getParams()');
		assert.strictEqual(rewriteGroovyEvaluate('this.params.id'), 'this.getParams().get("id")');
	});

	test('keeps method calls on the rewritten receiver', () => {
		assert.strictEqual(rewriteGroovyEvaluate('params.int("id")'), 'getParams().int("id")');
		assert.strictEqual(rewriteGroovyEvaluate('request.getHeader("X")'), 'getRequest().getHeader("X")');
		assert.strictEqual(rewriteGroovyEvaluate('getParams()'), 'getParams()');
	});

	test('finds the evaluatable chain under the cursor', () => {
		const line = '    def name = params.id';
		const atId = line.indexOf('id');
		const span = findEvaluatableExpression(line, atId);
		assert.ok(span);
		assert.strictEqual(span!.expression, 'params.id');
		assert.strictEqual(rewriteGroovyEvaluate(span!.expression), 'getParams().get("id")');
	});

	test('collects inline specs for locals and skips property suffix identifiers', () => {
		const source = 'def index() {\n    def name = params.id\n    // ignore params here\n}\n';
		const specs = collectInlineValueSpecs(source);
		assert.ok(specs.some(spec => spec.name === 'name' && spec.kind === 'lookup'));
		assert.ok(specs.some(spec => spec.name === 'params' && spec.kind === 'lookup'));
		assert.ok(!specs.some(spec => spec.name === 'id'));
		assert.ok(!specs.some(spec => spec.name === 'def'));
	});

	test('isPurePropertyPath rejects calls and assignment', () => {
		assert.ok(isPurePropertyPath('params.id'));
		assert.ok(isPurePropertyPath('user?.name'));
		assert.ok(!isPurePropertyPath('params.int("id")'));
		assert.ok(!isPurePropertyPath('x = 1'));
	});

	test('java bean getter capitalises the property name', () => {
		assert.strictEqual(javaBeanGetter('name'), 'getName()');
	});

	test('rejects failed evaluation messages', () => {
		assert.ok(isUsefulEvalResult({ result: 'GrailsParameterMap@1' }));
		assert.ok(!isUsefulEvalResult({ result: 'Evaluation failed: cannot resolve params' }));
		assert.ok(!isUsefulEvalResult({ result: 'Cannot evaluate, please specify projectName' }));
		assert.ok(!isUsefulEvalResult(undefined));
		assert.ok(isMissingJavaProjectError('Cannot evaluate because of java.lang.IllegalStateException: Cannot evaluate, please specify projectName in launch.json.'));
		assert.ok(!isMissingJavaProjectError('Evaluation failed: unknown identifier'));
	});

	test('splits Groovy property paths including getters and map keys', () => {
		assert.deepStrictEqual(splitPropertyPath('params.id'), ['params', 'id']);
		assert.deepStrictEqual(splitPropertyPath("params['name']"), ['params', 'name']);
		assert.deepStrictEqual(splitPropertyPath('getParams()'), ['params']);
		assert.deepStrictEqual(splitPropertyPath('this.params.id'), ['this', 'params', 'id']);
	});

	test('resolves params from this children without evaluate', async () => {
		const thisNode = { name: 'this', value: 'FooController', variablesReference: 2 };
		const paramsNode = { name: 'params', value: '{id=1}', type: 'GrailsParameterMap', variablesReference: 3 };
		const idNode = { name: 'id', value: '1', variablesReference: 0 };
		const extras = await collectGrailsImplicitsFromTree([thisNode], async ref => {
			if (ref === 2) {
				return [paramsNode];
			}
			return [];
		});
		assert.strictEqual(extras[0]?.name, 'params');
		const resolved = await resolveVariablePath(['params', 'id'], [thisNode], async ref => {
			if (ref === 2) {
				return [paramsNode];
			}
			if (ref === 3) {
				return [idNode];
			}
			return [];
		});
		assert.strictEqual(resolved?.value, '1');
		assert.ok(findNamedVariable([paramsNode], 'params'));
	});

	test('builds Java evaluate candidates for Grails implicits', () => {
		const params = javaEvaluateExpressions('params');
		assert.ok(params.includes('org.grails.web.servlet.mvc.GrailsWebRequest.lookup().getParams()'));
		assert.ok(params.includes('getParams()'));
		const key = javaEvaluateExpressions('params.pageId');
		assert.ok(key.includes('org.grails.web.servlet.mvc.GrailsWebRequest.lookup().getParams().get("pageId")'));
		const bean = javaEvaluateExpressions('user.name');
		assert.ok(bean.includes('user.getName()'));
		assert.ok(!bean.some(item => item.includes('GrailsWebRequest')));
	});
});
