import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClassIndexStore } from '../../groovy/class_index_store';
import { GrailsArtifactIndex, indexGroovyFile } from '../../groovy/grails_artifact_index';
import {
	ControllerActionContext,
	currentControllerName,
	findGroovyLinkArgAt,
	findGspTagLinkArgAt,
	resolveControllerActionDefinitions
} from '../../gsp/controller_action_navigation_logic';
import { listEmbeddedLinkArgs, resolveGspDefinitions } from '../../gsp/gsp_definition_logic';

const BILL_CONTROLLER = `package com.example

class BillController extends BaseController {

    def index() {
        redirect action: "list"
    }

    def list() {
        render(view: "list", model: [items: []])
    }

    def show(Long id) {
        render(view: "/shared/detail")
    }
}
`;

const BASE_CONTROLLER = `package com.example

abstract class BaseController {

    def health() {
        render "ok"
    }
}
`;

const ADMIN_BILL_CONTROLLER = `package com.example.admin

class BillController {

    def list() {
    }
}
`;

const PROJECT_FILES: Record<string, string> = {
	'web/grails-app/controllers/com/example/BillController.groovy': BILL_CONTROLLER,
	'web/src/main/groovy/com/example/BaseController.groovy': BASE_CONTROLLER,
	'admin/grails-app/controllers/com/example/admin/BillController.groovy': ADMIN_BILL_CONTROLLER,
	'web/src/test/groovy/com/example/BillController.groovy': BILL_CONTROLLER,
	'web/grails-app/views/bill/list.gsp': '<p>list</p>\n',
	'web/grails-app/views/bill/_list.gsp': '<p>template</p>\n',
	'web/grails-app/views/bill/templates/_row.gsp': '<p>row</p>\n',
	'web/grails-app/views/shared/detail.gsp': '<p>detail</p>\n',
	'web/grails-app/views/layouts/main.gsp': '<p>layout</p>\n',
	'web/grails-app/outside.gsp': '<p>outside</p>\n'
};

function at(text: string, marker: string, delta = 1): number {
	const index = text.indexOf(marker);
	assert.ok(index >= 0, `marker ${marker} not found`);
	return index + delta;
}

suite('controller_action_navigation_logic', () => {
	let root: string;
	let artifactIndex: GrailsArtifactIndex;
	const file = (relative: string) => path.join(root, relative);
	const context = (sourceRelative: string): ControllerActionContext => ({
		sourcePath: file(sourceRelative),
		workspaceRoot: root,
		findEntries: className => artifactIndex.findAllByClassName(className)
	});
	const resolveGroovy = (text: string, offset: number, sourceRelative: string) => {
		const hit = findGroovyLinkArgAt(text, offset);
		assert.ok(hit, 'expected a link argument under the cursor');
		return resolveControllerActionDefinitions(hit!, context(sourceRelative));
	};

	suiteSetup(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-groovy-links-'));
		artifactIndex = new GrailsArtifactIndex();
		for (const [relative, content] of Object.entries(PROJECT_FILES)) {
			fs.mkdirSync(path.dirname(file(relative)), { recursive: true });
			fs.writeFileSync(file(relative), content);
			if (relative.endsWith('.groovy')) {
				artifactIndex.addEntry(indexGroovyFile(file(relative)));
			}
		}
	});

	suiteTeardown(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	suite('Groovy named arguments', () => {
		test('pairs an action with the controller of a call spanning several lines', () => {
			const text = 'def url = createLink(\n    controller: "bill",\n    action: "show",\n    params: [id: 1]\n)';
			const hit = findGroovyLinkArgAt(text, at(text, '"show"'));
			assert.strictEqual(hit?.arg.name, 'action');
			assert.strictEqual(hit?.arg.value, 'show');
			assert.strictEqual(hit?.call.callee, 'createLink');
			assert.deepStrictEqual(hit?.call.args.map(arg => [arg.name, arg.value]), [['controller', 'bill'], ['action', 'show']]);
		});

		test('keeps two calls on the same line apart', () => {
			const text = 'def links = [createLink(controller: "report", action: "index"), createLink(action: "list")]';
			const hit = findGroovyLinkArgAt(text, at(text, '"list"'));
			assert.deepStrictEqual(hit?.call.args.map(arg => arg.name), ['action']);
		});

		test('reads the command form without parentheses, also across lines', () => {
			const single = 'redirect action: "index"';
			assert.strictEqual(findGroovyLinkArgAt(single, at(single, '"index"'))?.call.callee, 'redirect');
			const multi = 'if (done) {\n    redirect controller: "bill",\n        action: "list"\n}';
			const hit = findGroovyLinkArgAt(multi, at(multi, '"list"'));
			assert.strictEqual(hit?.call.callee, 'redirect');
			assert.deepStrictEqual(hit?.call.args.map(arg => arg.value), ['bill', 'list']);
		});

		test('takes the last segment of a qualified callee', () => {
			const text = 'grailsLinkGenerator.link(controller: "bill", action: "show")';
			assert.strictEqual(findGroovyLinkArgAt(text, at(text, '"show"'))?.call.callee, 'link');
		});

		test('ignores arguments inside comments and strings', () => {
			const comment = '// redirect(action: "list")';
			assert.strictEqual(findGroovyLinkArgAt(comment, at(comment, '"list"')), undefined);
			const string = 'String code = "redirect(action: \'list\')"';
			assert.strictEqual(findGroovyLinkArgAt(string, at(string, 'list')), undefined);
		});

		test('ignores calls that do not link to controllers', () => {
			const interceptor = 'match(controller: "bill", action: "*")';
			assert.strictEqual(findGroovyLinkArgAt(interceptor, at(interceptor, '"bill"')), undefined);
			const audit = 'new AuditEntry(action: "list")';
			assert.strictEqual(findGroovyLinkArgAt(audit, at(audit, '"list"')), undefined);
			const linkView = 'createLink(view: "list")';
			assert.strictEqual(findGroovyLinkArgAt(linkView, at(linkView, '"list"')), undefined);
		});

		test('treats a literal followed by an expression as dynamic', () => {
			const concatenated = 'redirect(action: "list" + suffix)';
			assert.strictEqual(findGroovyLinkArgAt(concatenated, at(concatenated, '"list"')), undefined);
			const called = 'redirect(action: "list".toString())';
			assert.strictEqual(findGroovyLinkArgAt(called, at(called, '"list"')), undefined);
			const commented = 'redirect action: "list" // back to the list';
			assert.strictEqual(findGroovyLinkArgAt(commented, at(commented, '"list"'))?.arg.value, 'list');
			const text = 'createLink(controller: "bill" + suffix, action: "list")';
			const hit = findGroovyLinkArgAt(text, at(text, '"list"'));
			assert.deepStrictEqual(hit?.call.args.map(arg => [arg.name, arg.value]), [['controller', undefined], ['action', 'list']]);
		});

		test('ignores arguments nested in another map', () => {
			const text = 'createLink(action: "list", params: [action: "show"])';
			assert.strictEqual(findGroovyLinkArgAt(text, at(text, '"show"')), undefined);
		});

		test('leaves dynamic values to the other resolvers', () => {
			const gstring = 'redirect(action: "${next}")';
			assert.strictEqual(findGroovyLinkArgAt(gstring, at(gstring, 'next')), undefined);
			const wildcard = "redirect(action: '*')";
			assert.strictEqual(findGroovyLinkArgAt(wildcard, at(wildcard, '*', 0)), undefined);
		});
	});

	suite('GSP tags', () => {
		test('reads controller and action attributes of a tag spanning several lines', () => {
			const text = '<g:link\n    controller="bill"\n    action="show" id="${bill.id}">Open</g:link>';
			const hit = findGspTagLinkArgAt(text, at(text, '"show"'));
			assert.strictEqual(hit?.call.callee, 'link');
			assert.deepStrictEqual(hit?.call.args.map(arg => [arg.name, arg.value]), [['controller', 'bill'], ['action', 'show']]);
		});

		test('ignores HTML forms, project tags and positions after the tag', () => {
			const html = '<form action="save" method="post">';
			assert.strictEqual(findGspTagLinkArgAt(html, at(html, '"save"')), undefined);
			const custom = '<demoUI:filter controller="bill" action="list"/>';
			assert.strictEqual(findGspTagLinkArgAt(custom, at(custom, '"list"')), undefined);
			const after = '<g:link action="list">list</g:link>';
			assert.strictEqual(findGspTagLinkArgAt(after, after.indexOf('>list') + 2), undefined);
		});

		test('stops at the start of a document that opens with a scriptlet', () => {
			const text = '<%@ page contentType="text/html" %> action="list"';
			assert.strictEqual(findGspTagLinkArgAt(text, at(text, '"list"')), undefined);
			const lessThan = '< b && action="list"';
			assert.strictEqual(findGspTagLinkArgAt(lessThan, at(lessThan, '"list"')), undefined);
		});

		test('leaves expressions in attribute values to the other resolvers', () => {
			const text = '<g:link controller="${done ? \'bill\' : \'report\'}" action="show">';
			assert.strictEqual(findGspTagLinkArgAt(text, at(text, 'done')), undefined);
		});

		test('ignores data attributes named like controller or action', () => {
			const text = '<g:link data-controller="modal" controller="bill" data-action="toggle" action="show">';
			const hit = findGspTagLinkArgAt(text, at(text, '"show"'));
			assert.deepStrictEqual(hit?.call.args.map(arg => [arg.name, arg.value]), [['controller', 'bill'], ['action', 'show']]);
			assert.strictEqual(findGspTagLinkArgAt(text, at(text, '"modal"')), undefined);
			assert.strictEqual(findGspTagLinkArgAt(text, at(text, '"toggle"')), undefined);
		});

		test('reads a quoted greater-than sign inside the tag', () => {
			const text = '<g:form title="a > b" controller="bill" action="list">';
			assert.strictEqual(findGspTagLinkArgAt(text, at(text, '"list"'))?.arg.value, 'list');
		});
	});

	suite('current controller', () => {
		test('comes from the views folder of a GSP or the controller file name', () => {
			assert.strictEqual(currentControllerName('/p/grails-app/views/bill/templates/_row.gsp'), 'bill');
			assert.strictEqual(currentControllerName('/p/grails-app/views/bankSlip/show.gsp'), 'bankSlip');
			assert.strictEqual(currentControllerName('/p/grails-app/controllers/com/x/BankSlipController.groovy'), 'bankSlip');
			assert.strictEqual(currentControllerName('/p/grails-app/services/com/x/BillService.groovy'), undefined);
			assert.strictEqual(currentControllerName('/p/grails-app/views/index.gsp'), undefined);
		});
	});

	suite('resolution', () => {
		test('opens the action method of the named controller', () => {
			const text = 'createLink(controller: "bill", action: "show")';
			const targets = resolveGroovy(text, at(text, '"show"'), 'web/grails-app/taglib/com/example/LinkTagLib.groovy');
			assert.deepStrictEqual(targets.map(target => [target.uri, target.line]), [
				[file('web/grails-app/controllers/com/example/BillController.groovy'), 12]
			]);
		});

		test('opens the controller class', () => {
			const text = 'createLink(controller: "bill", action: "show")';
			const targets = resolveGroovy(text, at(text, '"bill"'), 'web/grails-app/taglib/com/example/LinkTagLib.groovy');
			assert.deepStrictEqual(targets.map(target => [target.uri, target.line, target.column]), [
				[file('web/grails-app/controllers/com/example/BillController.groovy'), 2, 0]
			]);
		});

		test('uses the current controller and finds actions inherited from a base controller', () => {
			const targets = resolveGroovy(BILL_CONTROLLER, at(BILL_CONTROLLER, '"list"'), 'web/grails-app/controllers/com/example/BillController.groovy');
			assert.deepStrictEqual(targets.map(target => target.line), [8]);
			const text = 'redirect(action: "health")';
			const inherited = resolveGroovy(text, at(text, '"health"'), 'web/grails-app/controllers/com/example/BillController.groovy');
			assert.deepStrictEqual(inherited.map(target => [target.uri, target.line]), [
				[file('web/src/main/groovy/com/example/BaseController.groovy'), 4]
			]);
		});

		test('prefers the controller of the same module', () => {
			const text = 'createLink(controller: "bill", action: "list")';
			const fromAdmin = resolveGroovy(text, at(text, '"list"'), 'admin/grails-app/views/report/index.gsp');
			assert.deepStrictEqual(fromAdmin.map(target => target.uri), [
				file('admin/grails-app/controllers/com/example/admin/BillController.groovy')
			]);
		});

		test('does not navigate to a missing action, controller or view', () => {
			const missingAction = 'createLink(controller: "bill", action: "archive")';
			assert.deepStrictEqual(resolveGroovy(missingAction, at(missingAction, '"archive"'), 'web/grails-app/views/bill/list.gsp'), []);
			const missingController = 'createLink(controller: "ledger", action: "list")';
			assert.deepStrictEqual(resolveGroovy(missingController, at(missingController, '"list"'), 'web/grails-app/views/bill/list.gsp'), []);
			const missingView = 'render(view: "archive")';
			assert.deepStrictEqual(resolveGroovy(missingView, at(missingView, '"archive"'), 'web/grails-app/controllers/com/example/BillController.groovy'), []);
		});

		test('does not guess the controller when it is not a literal', () => {
			const text = 'createLink(controller: controllerName, action: "list")';
			assert.deepStrictEqual(resolveGroovy(text, at(text, '"list"'), 'web/grails-app/controllers/com/example/BillController.groovy'), []);
		});

		test('does not navigate an action without a controller outside controllers and their views', () => {
			const text = 'redirect(action: "list")';
			assert.deepStrictEqual(resolveGroovy(text, at(text, '"list"'), 'web/grails-app/services/com/example/BillService.groovy'), []);
			assert.deepStrictEqual(resolveGroovy(text, at(text, '"list"'), 'web/grails-app/views/layouts/main.gsp'), []);
		});

		test('opens relative and absolute views, preferring the view over a template of the same name', () => {
			const controller = 'web/grails-app/controllers/com/example/BillController.groovy';
			const relative = resolveGroovy(BILL_CONTROLLER, at(BILL_CONTROLLER, 'view: "list"', 7), controller);
			assert.deepStrictEqual(relative.map(target => target.uri), [file('web/grails-app/views/bill/list.gsp')]);
			const absolute = resolveGroovy(BILL_CONTROLLER, at(BILL_CONTROLLER, '"/shared'), controller);
			assert.deepStrictEqual(absolute.map(target => target.uri), [file('web/grails-app/views/shared/detail.gsp')]);
		});

		test('opens a view relative to another folder but not a file outside the views folder', () => {
			const controller = 'web/grails-app/controllers/com/example/BillController.groovy';
			const sibling = 'render(view: "../shared/detail")';
			assert.deepStrictEqual(resolveGroovy(sibling, at(sibling, '"../'), controller).map(target => target.uri), [
				file('web/grails-app/views/shared/detail.gsp')
			]);
			const outside = 'render(view: "/a/../../outside")';
			assert.deepStrictEqual(resolveGroovy(outside, at(outside, '"/a'), controller), []);
		});

		test('opens the view of respond after a positional argument', () => {
			const text = 'respond bills, view: "list"';
			const targets = resolveGroovy(text, at(text, '"list"'), 'web/grails-app/controllers/com/example/BillController.groovy');
			assert.deepStrictEqual(targets.map(target => target.uri), [file('web/grails-app/views/bill/list.gsp')]);
		});
	});

	suite('GSP definitions', () => {
		const resolveInGsp = (documentText: string, offset: number, sourceRelative: string) => {
			const lines = documentText.slice(0, offset).split('\n');
			return resolveGspDefinitions({
				documentText,
				line: lines.length - 1,
				character: lines[lines.length - 1].length,
				sourcePath: file(sourceRelative),
				workspaceRoot: root,
				tags: [],
				classStore: new ClassIndexStore(),
				artifactIndex
			});
		};

		test('navigates from g:link using the controller of the views folder', () => {
			const text = '<g:link action="show" id="1">Show</g:link>';
			const targets = resolveInGsp(text, at(text, '"show"'), 'web/grails-app/views/bill/templates/_row.gsp');
			assert.deepStrictEqual(targets.map(target => [target.uri, target.line]), [
				[file('web/grails-app/controllers/com/example/BillController.groovy'), 12]
			]);
		});

		test('navigates from createLink inside an expression', () => {
			const text = '<a href="${createLink(controller: \'bill\', action: \'list\')}">List</a>';
			const targets = resolveInGsp(text, at(text, "'list'"), 'web/grails-app/views/shared/detail.gsp');
			assert.deepStrictEqual(targets.map(target => [target.uri, target.line]), [
				[file('web/grails-app/controllers/com/example/BillController.groovy'), 8]
			]);
		});

		test('keeps resolving Groovy inside a dynamic controller attribute', () => {
			const text = '<g:link controller="${BillController.simpleName}" action="show">';
			const targets = resolveInGsp(text, at(text, 'BillController'), 'web/grails-app/views/bill/list.gsp');
			assert.ok(targets.some(target => target.uri.endsWith('BillController.groovy')));
		});

		test('lists the link values inside expressions with their document offsets', () => {
			const text = '<form action="${createLink(action: \'index\')}">\n<a href="${createLink(controller: \'bill\', action: \'list\')}">x</a>\n<g:link action="show">s</g:link>\n<script>var options = { action: \'save\' };</script>';
			const args = listEmbeddedLinkArgs(text);
			assert.deepStrictEqual(args.map(arg => text.slice(arg.start, arg.end)), ['index', 'bill', 'list']);
			assert.deepStrictEqual(args.map(arg => arg.hit.arg.name), ['action', 'controller', 'action']);
		});

		test('keeps resolving render templates', () => {
			const text = '<g:render template="/bill/templates/row"/>';
			const targets = resolveInGsp(text, at(text, 'templates'), 'web/grails-app/views/bill/list.gsp');
			assert.deepStrictEqual(targets.map(target => target.uri), [file('web/grails-app/views/bill/templates/_row.gsp')]);
		});
	});
});
