# Change Log
All notable changes to the "code-groovy" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]
- Go to Definition (Ctrl+Click / Cmd+Click) on a property read such as `invoice.receiptCode` or `invoice?.overdue` opens the `getReceiptCode()` or `isOverdue()` getter when the class has no field with that name and the receiver type is known (declared type, property chain, `this` or class name)
- Go to Definition on a getter declaration and Find All References also list its property reads, scoped to the declaring class and its subclasses; reads are searched in the files that mention the class, so a read reached only through a chain of other classes is not listed

## [0.2.5] - 2026-10-02
- Jump from a method or class declaration to where it's used (Go to Definition — Ctrl+Click, Cmd+Click on macOS), mirroring IntelliJ's "Go to Declaration or Usages", including overloaded methods and constructors
- Support Find All References for Groovy (`Shift+F12`) on methods and classes, using the same lookup as Go to Definition, backed by an in-memory call-site index and a per-class file index built during the existing indexing pass — once the index is ready, a request only reads the files that mention the class instead of the whole workspace; from a call site it reads the receiver the same way as the index (`super.method()` targets the superclass, a receiver on the previous line is used, a chain of typed properties such as `order.status?.isFinished()` is resolved field by field, and the end of a call chain falls back to the current file)
- Scope usage search to calls on the declaring class — through its Grails field name (field name = class name in camelCase), the class itself (static calls), variables and parameters typed with it, or from inside the class — and show nothing rather than unrelated same-named calls from other classes
- Resolve a receiver by its declared type when it has one, even if the variable is named like another class's Grails field, and only from declarations in the enclosing method (a later `def x = ...` or closure parameter hides an earlier typed one); the end of a call chain (`a().b()`, a receiver on the previous line) is no longer counted as a call inside the current class, and methods declared after a nested type (e.g. a `static enum` at the top of the class) belong to the outer class; parameter types are kept across multi-line signatures and Allman-style braces, and declarations inside strings (such as SQL in triple-quoted strings) are no longer parsed as methods, classes or fields; a receiver chain such as `order.status?.isFinished()` or `Status.PAID.isFinished()` is resolved field by field (including inherited fields and enum constants) through a field-type index, and its last segment is never typed from a local variable with the same name; `for (Type item in list)` and `for (Type item : list)` loop variables are typed too
- Follow the type hierarchy when looking up method usages: an `@Override` of a trait, interface or superclass method includes the calls made through that supertype (such as a `CronJob` trait calling `task()`), an inherited method includes calls from subclasses (including `super.method()`), and when nothing calls the method, Go to Definition (Ctrl+Click / Cmd+Click) and Find All References fall back to the supertype's declaration; supertypes are resolved by fully qualified name (imports, same package, wildcard imports), so same-named supertypes in different packages are not mixed, and a subclass that overrides the method is left out (its calls go to the override, while its `super.method()` calls still count)
- Re-index only the files that changed when a source file is saved, run index refreshes one at a time, and mask comments and strings once per file with a faster scanner, so saving no longer re-parses the whole workspace, and deduplicate the names kept in the index so each file's text is not retained in memory
- Detect Groovy's paren-less closure call syntax (`receiver.method { ... }`, e.g. GORM's `.where`, `.each`, `.findAll`), safe-navigation/spread calls (`receiver?.method()`, `list*.method()`) and calls inside GString interpolation (`"${service.call()}"`) as usages, while ignoring calls that only appear in comments
- Find usages of a class/domain type too (constructor calls and static/closure calls on it), not just methods
- Also count a class referenced only as a type (typed field/parameter) as used, scanning only the files that mention it and skipping `import` lines, comments and string contents
- Count calls through untyped Grails service injection (`def someService`, then `someService.call()`) as usages of the service class, for both Go to Definition (Ctrl+Click / Cmd+Click) and Find All References, by matching the Grails field-name convention (field name = class name in camelCase, kept as-is when it starts with an acronym like `URLService`) even when the class name itself never appears as literal text
- Recognize method declarations with generic or array return types, type parameters, same-line annotations or only modifiers (`Map<String, Object> build(...)`, `String[] names()`, `static <T> T find(...)`, `@Transactional def save()`, `static create(...)`) in the usage index, in Go to Definition (Ctrl+Click / Cmd+Click) and in method completion, keep constructors out of the method list, and stop treating `return foo(...)` as a declaration
- Resolve a method call through the receiver's declared type for Go to Definition (Ctrl+Click / Cmd+Click) — a local variable or parameter (`ReceivableAnticipationSimulationAdapter simulationAdapter` then `simulationAdapter.toMap()`) or a chain of typed properties with safe navigation (`abTest.category?.isPricing()` through `AbTest.category`) — before falling back to the class name derived from the variable name; when an inherited method's supertype has a same-named class in another package, the one the subclass refers to (explicit import, same package, then wildcard import) is opened, and method completion (`receiver.`) lists the methods inherited from that supertype only; `super.method()` opens the supertype's method
- Add Go to Definition (Ctrl+Click / Cmd+Click) for field and property access (`receiver.field`, including `this.field` and property chains such as `card?.brand.code`), resolving the receiver's declared type (local variable, parameter or typed property) from the enclosing document before falling back to the Grails naming convention, and matching only class-level fields and properties (not local variables of the target class)
- Go to Definition (Ctrl+Click / Cmd+Click) on an enum constant or a static field (`CardBrand.MASTERCARD`, `Limits.MAX_VALUE`) opens that constant or field, and on an enum constant's own declaration opens the constructor it calls (matched by argument count), or the enum itself when it has no constructor, like IntelliJ
- Do not offer Go to Definition (Ctrl+Click / Cmd+Click) on words inside `//` and `/* */` comments, except `{@link ...}`, `@see` and `@throws` references in Groovydoc
- Go to Definition (Ctrl+Click / Cmd+Click) on a constant of a one-line enum (`enum Kind { A, B }`) opens the enum, a constructor declared without modifiers (`WidgetKind(String code)`) is treated as a declaration of its class, enum constants after a constant body or closure argument on the same line (`PLUS { ... }, MINUS`) are recognized, and a recursive call on the declaration line (`n * fact(n - 1)`) is kept as a usage
- Class usages highlight the receiver (`Widget.get(1)`, `widgetService.rename()`) instead of the called method, and slashy strings (`~/^\/api\/*$/`) no longer hide the rest of the file from the index or from comment detection
- Keep Windows (CRLF) line endings from hiding classes, enums, constructors and supertypes from the index and from auto-import
- Resolve same-named classes in different packages by what each file imports or shares a package with, so usages of one no longer include the other, including `super.method()` through wildcard imports and imports with an alias (`import a.Base as OneBase`)
- Find All References on an enum constant or a static constant lists `Type.CONSTANT` uses and the uses inside the declaring type only, not same-named constants of other types or local variables, and Find All References from a call site includes the declaration when requested
- Go to Definition (Ctrl+Click / Cmd+Click) resolves `super.method()`, `this.field` and own methods through the class under the cursor (not the first class of the file), a receiver on the previous line, nested types (`Holder.Status.OPEN`), types declared in a file with another name and `import static` constants
- Read class headers split across lines or with annotations on the same line, members declared on the same line as a one-line class or enum, method pointers (`service.&method`), qualified constructor calls (`new com.acme.Widget()`), `var` declarations, dollar-slashy strings and slashy strings after `in`, `case`, `*` and `+`
- Update the index incrementally on save (only the changed files' entries), discover source files without blocking the editor, and parse each document once per request; F2 rename now skips slashy strings and renames inside GString interpolation

## [0.2.4] - 2026-10-02
- Publish the extension to [Open VSX](https://open-vsx.org/extension/marlon407/code-groovy) (no functional changes)

## [0.2.3] - 2026-09-28
- Internal: add CI, contribution guidelines and automated release workflow (no functional changes)

## [0.2.2] - 2026-09-26
- Add `codeGroovy.importOrder.warnings` to disable import-order **Problems** warnings without hiding other diagnostics ([#54](https://github.com/code-groovy/code-groovy/issues/54))

## [0.2.1] - 2026-09-04
- Do not treat `identifier / number` as a Groovy slashy string (division stays division; `= /regex/` still highlights)
- Ctrl+click another TagLib from Groovy (`catalogTagLib.method` / `namespace.method`) and `g.render(template: "...")` the same way as in GSP
- Support Ctrl+click / Go to Definition in `.gsp` for project TagLib tags (`<ns:tag>` / `ns.method`) and Groovy inside `${...}` / `<%...%>` (including when VS Code routes `${}` to the Groovy language)
- Ctrl+click `template=` / `src=` / `url=` on `g:render` and `asset:*` tags to open the view or asset file (full path underlined, prefers `.scss` over compiled `.css`)
- Disable HTML `editor.links` in `.gsp` so attribute values like `action="${g.createLink(...)}"` are not opened as fake file paths
- Point Grails `g:` tag hover/reference links at the legacy GSP docs (`docs-legacy-gsp`) instead of the broken `/docs/latest/ref/Tags/` URLs
- Support F2 rename for identifiers in the current Groovy file (skips comments/strings; same-file only)
- Highlight Grails tags (`g:if`, etc.) correctly when nested inside an HTML open tag in `.gsp`
- Ship a Groovy TextMate grammar (slashy strings + Spock quoted method names) so `.groovy` highlighting is owned by this extension
- Show Groovydoc / Javadoc comments on hover for Groovy types and methods (Markdown rendering of common tags)
- Include methods with generic return types (e.g. `Map`, `List<Map>`) in document symbols / outline
- Match square brackets `[` `]` in GSP bracket matching
- Include TagLib-style closure assignments (`def myTag = { ... }`) in document symbols / outline
- Auto-import Groovy/Java types from workspace source and Gradle/Maven JAR classpaths via IntelliSense and a Quick Fix
- Rank auto-import suggestions so workspace types like `Customer` stay above longer JAR names such as `CustomerAccountDTO`
- Insert auto-imported lines in sorted position without reshuffling existing imports; warn (yellow) on out-of-order import lines
- Add Ctrl+click Go to Definition for Groovy types, methods, services, and inherited methods (workspace + JAR sources when available)
- Suggest workspace/Grails methods on member access (`receiver.`) using the same artifact hierarchy as Go to Definition
- Improve navigation with Grails artifact index (class file name), service bean resolution, and method parsing adapted from grails-vscode patterns
- Enable HTML Emmet/HTML language features in `.gsp`, with coexistence settings so Emmet does not steal `g.each` / project `namespace.method`
- Add IntelliSense/hover hints for common Grails `g:` and Asset Pipeline `asset:` tags via HTML custom data
- Discover project `*TagLib.groovy` files and suggest tag methods/attributes after `namespace:` / `namespace.` in `.gsp`
- Infer self-closing vs body tags from `body()` usage; clean empty/broken tag pairs without undoing a typed `/`
- Serve Grails/Asset GSP completions from the provider (not JSON snippets) so accepting `g:each` after typing `g.each` never leaves `g.`
- Add broad fixture/scenario unit tests for core triggers, project taglibs, and empty/broken tag cleanup
- Show indexing progress in the status bar (percentage, current file/JAR, final counts) and a Code Groovy Index output channel
- Index entire workspace source trees (no 5k cap) and resolve Grails multi-module paths for go-to-definition fallbacks

## [0.1.3]
- Remove unused tslint and pin patched transitive dependencies (npm audit: 0)
- Require Node 24 for development (`engines.node` and `@types/node`)
- Upgrade Mocha to 12

## [0.1.2]
- Update development dependencies so the extension installs and packages on current Node and VS Code/Cursor
- Replace the deprecated `vscode` package with `@types/vscode`
- Raise `engines.vscode` to `^1.74.0` (runtime behavior unchanged)
