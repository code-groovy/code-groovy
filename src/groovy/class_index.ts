import * as vscode from 'vscode';
import { ClassIndexStore, indexJarFqns, IndexedType, MAX_INDEXED_CLASSES } from './class_index_store';
import { hashWorkspaceBuildFiles, resolveGradleProjectRoot, resolveProjectClasspath } from './classpath_resolver';
import { DefinitionProvider } from './definition_provider';
import { ReferenceProvider } from './reference_provider';
import { CallSiteIndexStore } from './call_site_index_store';
import { GrailsArtifactIndex } from './grails_artifact_index';
import { ImportCodeActionProvider } from './import_code_action_provider';
import { ImportCompletionProvider } from './import_completion_provider';
import { ImportOrderDiagnostics } from './import_order_diagnostics';
import { GroovydocHoverProvider } from './groovydoc_hover_provider';
import { IndexStatusBar } from './index_status';
import { listClassFqnsFromJar } from './jar_class_scanner';
import { MethodCompletionProvider } from './method_completion_provider';
import { RenameProvider } from './rename_provider';
import { discoverSourceFiles, invalidateSourceFiles } from './source_file_discovery';
import { planSourceRefresh } from './source_refresh_logic';
import { GroovyTagLibLinkProvider } from '../gsp/groovy_taglib_link_provider';
import { ProjectTagLibTag } from '../gsp/taglib_parser';
import { IndexStores, rebuildIndexStores, updateIndexStores } from './index_stores';
import { IndexedSource, indexSourceText } from './source_indexer';
import { TypeHierarchyStore } from './type_hierarchy_store';

const CACHE_KEY = 'codeGroovy.classpathIndex.v2';

interface CachedClasspath {
	hash: string;
	types: Array<{ simpleName: string; fqn: string }>;
	jars?: string[];
}

interface RefreshOptions {
	showProgress?: boolean;
	forceClasspath?: boolean;
}

export class ClassIndex implements vscode.Disposable {
	private readonly store = new ClassIndexStore();
	private readonly callSiteIndex = new CallSiteIndexStore();
	private readonly typeHierarchy = new TypeHierarchyStore();
	private readonly sourceCache = new Map<string, IndexedSource>();
	private storesBuilt = false;
	private readonly changedSources = new Set<string>();
	private sourceRefreshQueue: Promise<void> = Promise.resolve();
	private readonly artifactIndex = new GrailsArtifactIndex();
	private readonly completionProvider = new ImportCompletionProvider(this.store);
	private readonly methodCompletionProvider = new MethodCompletionProvider(this.artifactIndex);
	private readonly codeActionProvider = new ImportCodeActionProvider(this.store);
	private getGspTags: () => ProjectTagLibTag[] = () => [];
	private readonly definitionProvider = new DefinitionProvider(
		this.store,
		this.artifactIndex,
		() => this.lastClasspathJars,
		this.callSiteIndex,
		this.typeHierarchy,
		() => this.getGspTags()
	);
	private readonly referenceProvider = new ReferenceProvider(this.callSiteIndex, this.typeHierarchy);
	private readonly renameProvider = new RenameProvider();
	private readonly importOrderDiagnostics = new ImportOrderDiagnostics();
	private readonly disposables: vscode.Disposable[] = [];
	private sourceTimer: ReturnType<typeof setTimeout> | undefined;
	private classpathTimer: ReturnType<typeof setTimeout> | undefined;
	private warnedClasspath = false;
	private statusBar: IndexStatusBar | undefined;
	private extensionContext: vscode.ExtensionContext | undefined;
	private initialIndexComplete = false;
	private lastClasspathWarning: string | undefined;
	private lastClasspathTool: ClasspathResolution['tool'] | undefined;
	private lastJarCount = 0;
	private lastClasspathJars: string[] = [];
	private lastSourceFileCount = 0;
	private classpathFromCache = false;

	async start(context: vscode.ExtensionContext): Promise<void> {
		this.extensionContext = context;
		this.statusBar = new IndexStatusBar();
		this.statusBar.start(context);
		this.statusBar.log('Code Groovy index started');

		this.importOrderDiagnostics.start();
		this.disposables.push(
			this.importOrderDiagnostics,
			vscode.languages.registerCompletionItemProvider(
				{ language: 'groovy' },
				this.completionProvider
			),
			vscode.languages.registerCompletionItemProvider(
				{ language: 'groovy' },
				this.methodCompletionProvider,
				'.'
			),
			vscode.languages.registerCodeActionsProvider(
				{ language: 'groovy' },
				this.codeActionProvider,
				{ providedCodeActionKinds: ImportCodeActionProvider.providedCodeActionKinds }
			),
			vscode.languages.registerDefinitionProvider(
				{ language: 'groovy' },
				this.definitionProvider
			),
			vscode.languages.registerReferenceProvider(
				{ language: 'groovy' },
				this.referenceProvider
			),
			vscode.languages.registerDocumentLinkProvider(
				{ language: 'groovy' },
				new GroovyTagLibLinkProvider()
			),
			vscode.languages.registerHoverProvider(
				{ language: 'groovy' },
				new GroovydocHoverProvider(this.store)
			),
			vscode.languages.registerRenameProvider(
				{ language: 'groovy' },
				this.renameProvider
			)
		);

		const sourceWatcher = vscode.workspace.createFileSystemWatcher('**/*.{groovy,java}');
		sourceWatcher.onDidCreate(uri => this.scheduleSourceRefresh(uri, true));
		sourceWatcher.onDidChange(uri => this.scheduleSourceRefresh(uri, false));
		sourceWatcher.onDidDelete(uri => this.scheduleSourceRefresh(uri, true));
		this.disposables.push(sourceWatcher);
		this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('codeGroovy.modules') || event.affectsConfiguration('codeGroovy.index.maxSourceFiles')) {
				invalidateSourceFiles();
				this.refreshSource({ showProgress: false }).catch(error => this.logRefreshError('source', error));
			}
		}));

		const buildWatcher = vscode.workspace.createFileSystemWatcher(
			'**/{build.gradle,build.gradle.kts,settings.gradle,settings.gradle.kts,gradle.lockfile,pom.xml}'
		);
		buildWatcher.onDidCreate(() => this.scheduleClasspathRefresh());
		buildWatcher.onDidChange(() => this.scheduleClasspathRefresh());
		buildWatcher.onDidDelete(() => this.scheduleClasspathRefresh());
		this.disposables.push(buildWatcher);

		await this.refreshSource({ showProgress: true });
		await this.refreshClasspath({ showProgress: true });
		this.initialIndexComplete = true;
	}

	async rebuildIndex(): Promise<void> {
		const context = this.extensionContext;
		if (!context) {
			return;
		}
		this.warnedClasspath = false;
		this.lastClasspathWarning = undefined;
		await context.workspaceState.update(CACHE_KEY, undefined);
		await this.refreshSource({ showProgress: true });
		await this.refreshClasspath({ showProgress: true, forceClasspath: true });
	}

	showIndexOutput(): void {
		this.statusBar?.showOutput();
	}

	getStore(): ClassIndexStore {
		return this.store;
	}

	getArtifactIndex(): GrailsArtifactIndex {
		return this.artifactIndex;
	}

	getClasspathJars(): string[] {
		return this.lastClasspathJars;
	}

	/** Wire project TagLib index so embedded Groovy in `.gsp` can resolve `ns.method` calls. */
	setGspTagsProvider(getTags: () => ProjectTagLibTag[]): void {
		this.getGspTags = getTags;
	}

	dispose(): void {
		if (this.sourceTimer) {
			clearTimeout(this.sourceTimer);
		}
		if (this.classpathTimer) {
			clearTimeout(this.classpathTimer);
		}
		this.statusBar?.dispose();
		this.disposables.forEach(d => d.dispose());
	}

	private scheduleSourceRefresh(uri: vscode.Uri, filesAddedOrRemoved: boolean): void {
		this.changedSources.add(uri.fsPath);
		if (filesAddedOrRemoved) {
			invalidateSourceFiles();
		}
		if (this.sourceTimer) {
			clearTimeout(this.sourceTimer);
		}
		this.sourceTimer = setTimeout(() => {
			this.refreshSource({ showProgress: false }).catch(error => this.logRefreshError('source', error));
		}, 400);
	}

	private logRefreshError(kind: string, error: unknown): void {
		this.statusBar?.log(`Index ${kind} refresh failed: ${error instanceof Error ? error.message : String(error)}`);
	}

	private scheduleClasspathRefresh(): void {
		if (this.classpathTimer) {
			clearTimeout(this.classpathTimer);
		}
		this.classpathTimer = setTimeout(() => {
			this.refreshClasspath({ showProgress: true, forceClasspath: true }).catch(error => this.logRefreshError('classpath', error));
		}, 2000);
	}

	private refreshSource(options: RefreshOptions = {}): Promise<void> {
		this.sourceRefreshQueue = this.sourceRefreshQueue.then(() => this.runSourceRefresh(options), () => this.runSourceRefresh(options));
		return this.sourceRefreshQueue;
	}

	private async runSourceRefresh(options: RefreshOptions = {}): Promise<void> {
		const showProgress = options.showProgress ?? false;
		if (showProgress) {
			invalidateSourceFiles();
		}
		const { filePaths, grailsModules } = await discoverSourceFiles();
		if (showProgress) {
			this.statusBar?.log(grailsModules.length > 0
				? `Grails modules: ${grailsModules.map(module => module.name).join(', ')} (${filePaths.length} source file(s))`
				: `Workspace scan: ${filePaths.length} source file(s)`);
		}

		this.lastSourceFileCount = filePaths.length;

		if (showProgress) {
			this.statusBar?.beginSourceScan(filePaths.length);
		}

		const changed = new Set(this.changedSources);
		this.changedSources.clear();
		const plan = planSourceRefresh(filePaths, this.sourceCache.keys(), changed, showProgress);
		const incremental = !showProgress && this.storesBuilt;
		const previous = new Map<string, IndexedSource>();
		for (const filePath of [...plan.removed, ...plan.toIndex]) {
			const cached = this.sourceCache.get(filePath);
			if (cached) {
				previous.set(filePath, cached);
			}
		}
		for (const removedPath of plan.removed) {
			this.sourceCache.delete(removedPath);
		}

		for (let index = 0; index < filePaths.length; index++) {
			const filePath = filePaths[index];
			if (plan.toIndex.has(filePath)) {
				const indexed = await this.indexSourceFile(filePath);
				if (indexed) {
					this.sourceCache.set(filePath, indexed);
				} else {
					this.sourceCache.delete(filePath);
				}
			}
			if (showProgress) {
				this.statusBar?.progressSource(filePath, index + 1);
			}
		}

		if (incremental) {
			this.updateStores(previous, plan.toIndex);
		} else {
			this.rebuildStores();
		}

		if (!showProgress && this.initialIndexComplete) {
			this.finalizeStatus();
		}
	}

	private rebuildStores(): void {
		rebuildIndexStores(this.indexStores(), this.sourceCache);
		this.storesBuilt = true;
	}

	private updateStores(previous: Map<string, IndexedSource>, indexed: Set<string>): void {
		updateIndexStores(this.indexStores(), previous, indexed, this.sourceCache);
	}

	private indexStores(): IndexStores {
		return { classStore: this.store, callSiteIndex: this.callSiteIndex, typeHierarchy: this.typeHierarchy, artifactIndex: this.artifactIndex };
	}

	private async indexSourceFile(filePath: string): Promise<IndexedSource | undefined> {
		try {
			const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
			return indexSourceText(Buffer.from(bytes).toString('utf8'), filePath);
		} catch (error) {
			this.statusBar?.log(`Could not index ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}

	private async refreshClasspath(options: RefreshOptions = {}): Promise<void> {
		const context = this.extensionContext;
		const showProgress = options.showProgress ?? false;
		const forceClasspath = options.forceClasspath ?? false;
		const folderRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const root = folderRoot ? resolveGradleProjectRoot(folderRoot) : undefined;
		if (!root || !context) {
			if (showProgress) {
				this.finalizeStatus();
			}
			return;
		}

		const hash = hashWorkspaceBuildFiles(root);
		const cached = context.workspaceState.get<CachedClasspath>(CACHE_KEY);
		if (!forceClasspath && cached?.hash === hash && cached.types?.length) {
			this.store.removeBySource('jar');
			this.store.add(cached.types.map(type => ({ ...type, source: 'jar' as const })));
			if (cached.jars?.length) {
				this.lastClasspathJars = cached.jars;
			} else {
				const resolution = await resolveProjectClasspath(root);
				this.lastClasspathJars = resolution.jars;
				await context.workspaceState.update(CACHE_KEY, {
					hash: cached.hash,
					types: cached.types,
					jars: resolution.jars
				});
				this.statusBar?.log(`Classpath JAR list refreshed (${resolution.jars.length} JAR(s))`);
			}
			this.lastJarCount = this.lastClasspathJars.length;
			this.classpathFromCache = true;
			if (showProgress) {
				this.statusBar?.beginClasspathFromCache(cached.types.length);
			}
			this.finalizeStatus();
			return;
		}

		this.classpathFromCache = false;
		if (showProgress) {
			this.statusBar?.beginClasspathResolve('Gradle/Maven');
		}

		const resolution = await resolveProjectClasspath(root);
		this.lastClasspathTool = resolution.tool;
		this.lastClasspathWarning = resolution.warning;

		if (resolution.warning && !this.warnedClasspath) {
			this.warnedClasspath = true;
			void vscode.window.showWarningMessage(
				`${resolution.warning} Auto-import is limited to workspace source until the classpath is available.`
			);
		}

		const jars = resolution.jars;
		this.lastClasspathJars = jars;
		this.lastJarCount = jars.length;
		if (showProgress) {
			this.statusBar?.beginJarScan(jars.length);
		}

		const types: IndexedType[] = [];
		for (let index = 0; index < jars.length; index++) {
			const jar = jars[index];
			if (types.length >= MAX_INDEXED_CLASSES) {
				break;
			}
			try {
				const remaining = MAX_INDEXED_CLASSES - types.length;
				const fqns = listClassFqnsFromJar(jar).slice(0, remaining);
				types.push(...indexJarFqns(fqns, jar));
			} catch {
				// skip unreadable jars
			}
			if (showProgress) {
				this.statusBar?.progressJar(jar, index + 1);
			}
		}

		this.store.removeBySource('jar');
		this.store.add(types);

		if (types.length > 0) {
			await context.workspaceState.update(CACHE_KEY, {
				hash,
				types: types.map(type => ({ simpleName: type.simpleName, fqn: type.fqn })),
				jars
			});
		}

		if (showProgress) {
			this.finalizeStatus();
		}
	}

	private finalizeStatus(): void {
		if (!this.statusBar) {
			return;
		}
		const toolLabel = formatClasspathTool(this.lastClasspathTool);
		this.statusBar.complete({
			sourceFiles: this.lastSourceFileCount,
			workspaceTypes: this.store.countBySource('workspace'),
			artifactEntries: this.artifactIndex.entryCount(),
			artifactClasses: this.artifactIndex.classNameCount(),
			jarTypes: this.store.countBySource('jar'),
			jarCount: this.lastJarCount,
			classpathTool: toolLabel,
			fromCache: this.classpathFromCache,
			warning: this.lastClasspathWarning
		});
	}
}

type ClasspathResolution = Awaited<ReturnType<typeof resolveProjectClasspath>>;

function formatClasspathTool(tool: ClasspathResolution['tool'] | undefined): string | undefined {
	switch (tool) {
		case 'gradle':
			return 'Gradle';
		case 'maven':
			return 'Maven';
		case 'workspace':
			return 'workspace JARs';
		case 'none':
			return undefined;
		default:
			return undefined;
	}
}
