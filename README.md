# Code Groovy

Groovy, Grails and GSP language support for Visual Studio Code and Cursor.

[![Marketplace](https://vsmarketplacebadges.dev/version-short/marlon407.code-groovy.svg?label=marketplace&color=blue)](https://marketplace.visualstudio.com/items?itemName=marlon407.code-groovy)
[![Installs](https://vsmarketplacebadges.dev/installs-short/marlon407.code-groovy.svg?label=installs&color=blue)](https://marketplace.visualstudio.com/items?itemName=marlon407.code-groovy)
[![Rating](https://vsmarketplacebadges.dev/rating-short/marlon407.code-groovy.svg?label=rating&color=blue)](https://marketplace.visualstudio.com/items?itemName=marlon407.code-groovy)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

![Screenshot](code-groovy-0.0.5.gif)

## Features

### Navigation

- **Go to Definition** (`Ctrl`/`Cmd` + click, or `F12`) for Groovy classes, methods, services and inherited methods, resolving both workspace sources and the Gradle/Maven JAR classpath — including source JARs when they are available locally.
- **TagLib navigation across files**: jump from `catalogTagLib.method` or `namespace.method` in Groovy, and from `<ns:tag>` or `ns.method` in GSP, straight to the TagLib closure that defines it. Works for Groovy inside `${...}` and `<%...%>` blocks too.
- **Open views and assets from markup**: `Ctrl`/`Cmd` + click on `template=`, `src=` or `url=` in `g:render` and `asset:*` tags. The full attribute value is underlined, and `.scss` sources are preferred over compiled `.css`.
- **Document symbols and outline** covering TagLib closure assignments (`def myTag = { ... }`) and methods with generic return types such as `Map` or `List<Map>`.

### Imports

- **Auto-import** of Groovy and Java types from workspace source and Gradle/Maven JARs, offered both through IntelliSense and as a Quick Fix.
- Suggestions are ranked so workspace types like `Pet` stay above longer JAR names such as `PetProfileDTO`.
- New imports are inserted in sorted position without reshuffling existing lines, and out-of-order imports are flagged with a warning.
- **Organize imports** and **organize service injections** commands.

### IntelliSense and editing

- Method completion on member access (`receiver.`) following the same Grails artifact hierarchy used by Go to Definition.
- Completions for Grails `g:` and Asset Pipeline `asset:` tags, with hover documentation linking to the legacy GSP reference.
- Completions for your project's own TagLibs after `namespace:` or `namespace.`, inferring self-closing versus body tags from whether the closure calls `body()`.
- Groovydoc and Javadoc rendered as Markdown on hover.
- Rename (`F2`) for identifiers within the current Groovy file, skipping comments and strings.
- Groovy code snippets.

### Syntax highlighting

- Groovy TextMate grammar with support for slashy strings and Spock quoted method names. `identifier / number` is treated as division, while `= /regex/` still highlights as a slashy string.
- GSP grammar with embedded CSS, JavaScript and Groovy, correct highlighting for Grails tags nested inside HTML open tags, and bracket matching for `[` and `]`.
- HTML language features and Emmet enabled inside `.gsp`, configured so Emmet does not hijack `g.each` or your own `namespace.method` completions.

### Workspace indexing

- Indexes the workspace when the window opens (sources, then Gradle/Maven classpath). Grails multi-module layouts are used for go-to-definition fallbacks.
- Progress is reported in the status bar (percentage, current file or JAR, final counts) and in a dedicated **Code Groovy Index** output channel.

### Debug

- **Debug Groovy / Grails apps** from the Run and Debug view: launch `bootRun`/`run` with JDWP on the app JVM, or attach to a JVM already listening (default port 5005). Breakpoints in `.groovy` files are supported (uses the bundled Java debug extensions).

## Commands and keybindings

| Command | ID | Keybinding |
| --- | --- | --- |
| Debug Groovy / Grails Application | `cgroovy.debugApp` | — |
| Organize imports | `cgroovy.organizeImports` | `Cmd+Shift+O` / `Ctrl+Shift+O` |
| Organize dependences | `cgroovy.organizeDependences` | `Cmd+Shift+D` / `Ctrl+Shift+D` |
| Rebuild Code Groovy Index | `cgroovy.rebuildIndex` | — |
| Show Code Groovy Index Output | `cgroovy.showIndexOutput` | — |

Keybindings are active only while a `.groovy` or `.gsp` editor has focus.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `codeGroovy.debug.attachTimeoutMs` | `600000` | How long to wait for Gradle bootRun and the app JVM to open a JDWP port before giving up. |
| `codeGroovy.debug.gradleConsole` | `rich` | Gradle console mode in the **Groovy Debug** terminal (`rich` = colors, `plain` = no ANSI). |
| `codeGroovy.index.maxSourceFiles` | `0` | Maximum workspace `.groovy` / `.java` files to index when Grails module detection is **not** in use. `0` means no limit. |
| `codeGroovy.modules` | `["domain", "web", "api"]` | Gradle submodules to index when a `settings.gradle` is found. |
| `codeGroovy.importOrder.warnings` | `true` | Warn in **Problems** when imports are out of order (same order as **Organize imports**). Set `false` to turn off those warnings only. |

## Debug

Requires the Java extensions listed under **Requirements** (installed as dependencies). Code Groovy starts or attaches to the JVM; Debugger for Java owns stepping, variables and the call stack.

1. Set breakpoints in `.groovy` source.
2. Run **Debug Groovy / Grails Application** from the Command Palette, or pick **Groovy: Launch Grails** / **Groovy: Attach** in Run and Debug.
3. **Launch** starts `./gradlew :web:bootRun` in a Grails multi-module repo (`bootRun` at the root for a single module, `run` for Micronaut/plain Gradle), injects JDWP on the app `JavaExec`, waits for `Listening for transport dt_socket`, then attaches. Gradle output stays in the **Groovy Debug** integrated terminal (ANSI colors via `--console=rich` by default). A progress notification and status bar follow Gradle tasks (`:web:compileGroovy` → debug port → application running).
4. **Attach** connects to a JVM you already started with JDWP (port `5005`).

When the debugger stops in a Gradle copy under `bin/default` (common in Grails multi-module projects), Code Groovy remaps the stack frame to the matching `grails-app` / `src` file you edit.

Hover and the Watch view evaluate Grails implicits as Java (`GrailsWebRequest.lookup().getParams()`, `params.id` → `.get("id")`) so they work on Groovy stack frames. `params` / `session` / `request` / `flash` are also injected at the top of Locals when available.

Optional `launch.json` fields: `port`, `task`, `module`, `gradleArgs`, `sourcePaths`, `projectName`, `serverUrl`, `openBrowserOnReady`. For attach, use `hostName` and `port`. `projectName` is the Java project Debugger for Java uses to evaluate expressions (auto-detected as the Gradle module, usually `web`). Source directories under `grails-app` and `src/main/groovy` are detected automatically.

While a Groovy or GSP editor is focused, `Cmd`/`Ctrl`+`Shift`+`D` is bound to Organize dependences, not the Run and Debug view — use the Command Palette or rebind the key.

## Requirements

Visual Studio Code `1.74.0` or newer, or any recent Cursor build.

The extension declares these dependencies in `package.json` (Marketplace / Cursor install them together with Code Groovy):

- **HTML Language Features** (`vscode.html-language-features`) — built into VS Code/Cursor; GSP/Emmet support
- **Language Support for Java** (`redhat.java`)
- **Debugger for Java** (`vscjava.vscode-java-debug`) — required for Groovy/Grails debug (breakpoints, variables, step)

Syntax highlighting, snippets and GSP support work once Code Groovy is installed. Auto-import and go-to-definition against third-party libraries additionally require a populated Gradle or Maven cache on the machine. Resolution is more precise when source JARs have been downloaded.

## Known issues

- Rename is limited to the file currently open; it does not update references across the workspace.
- Breakpoints in `.gsp` are not supported.
- The default keybindings shadow VS Code's *Go to Symbol in Editor* (`Cmd/Ctrl+Shift+O`) and *Run and Debug* view (`Cmd/Ctrl+Shift+D`) while a Groovy or GSP file is focused. Rebind them in *Keyboard Shortcuts* if you prefer the defaults.
- On very large workspaces the first index can take a while. Narrow it down with `codeGroovy.modules`, or cap it with `codeGroovy.index.maxSourceFiles`.

## Development

```bash
git clone https://github.com/marlon407/code-groovy.git
cd code-groovy
npm install
npm run compile        # or: npm run watch
```

Press `F5` in VS Code to launch an Extension Development Host with the extension loaded.

```bash
npm run test:unit      # unit tests (fast, no editor required)
npm test               # unit tests + integration tests in a VS Code instance
npx vsce package       # build a .vsix
```

## Contributing

This is an open source project open to anyone, and contributions are extremely welcome.

Report any problems you face on the [issue tracker](https://github.com/marlon407/code-groovy/issues).

## License

Licensed under the [MIT License](LICENSE).

## Credits

Lots of help from [vscode-sort-lines](https://github.com/Tyriar/vscode-sort-lines/).

Groovy symbol support based on [vscode-groovy](https://gitlab.com/awl/vscode-grails).
