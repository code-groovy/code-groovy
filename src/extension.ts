'use strict';

import * as vscode from 'vscode';
import * as sortLines from './sort_lines';
import GroovyDocumentSymbolProvider from './groovy_document_symbol_provider';
import { ensureGspEmmetCoexistence } from './gsp/gsp_emmet_coexistence';
import { ClassIndex } from './groovy/class_index';
import { registerJarContentProvider } from './groovy/jar_content_provider';
import { GspDefinitionProvider } from './gsp/gsp_definition_provider';
import { GspResourceLinkProvider } from './gsp/gsp_resource_link_provider';
import { TagLibIndex } from './gsp/taglib_index';
import { registerGroovyDebug } from './debug/groovy_debug';
import { workspaceContainsGroovy } from './groovy/workspace_groovy';

let classIndex: ClassIndex | undefined;

export function activate(context: vscode.ExtensionContext) {
    
    const commands = [
      vscode.commands.registerCommand('cgroovy.organizeImports', sortLines.sortImports),
      vscode.commands.registerCommand('cgroovy.organizeDependences', sortLines.sortDependeces),
    ];
    
    const languages = [
      vscode.languages.registerDocumentSymbolProvider(  { language: 'groovy', scheme: 'file' }, new GroovyDocumentSymbolProvider())
    ];

    commands.forEach(command => context.subscriptions.push(command));
    languages.forEach(language => context.subscriptions.push(language));

    void ensureGspEmmetCoexistence();
    registerJarContentProvider(context);
    registerGroovyDebug(context);

    const tagLibIndex = new TagLibIndex();
    context.subscriptions.push(tagLibIndex);
    void tagLibIndex.start(context);

    classIndex = new ClassIndex();
    classIndex.setGspTagsProvider(() => tagLibIndex.getTags());
    context.subscriptions.push(classIndex);
    context.subscriptions.push(
      vscode.commands.registerCommand('cgroovy.showIndexOutput', () => classIndex?.showIndexOutput()),
      vscode.commands.registerCommand('cgroovy.rebuildIndex', () => classIndex?.rebuildIndex()),
      // Non-embedded GSP (HTML-style <ns:tag>). Embedded `${}` is handled by the Groovy
      // DefinitionProvider, which VS Code routes into source.groovy regions.
      vscode.languages.registerDefinitionProvider(
        { language: 'gsp' },
        new GspDefinitionProvider(tagLibIndex, classIndex)
      ),
      // Full-range underline + click for template=/src=/url= (not just one path segment).
      vscode.languages.registerDocumentLinkProvider(
        { language: 'gsp' },
        new GspResourceLinkProvider()
      )
    );
    void workspaceContainsGroovy().then(hasGroovy => {
        if (hasGroovy) {
            void classIndex?.start(context);
        }
    });
}

export function deactivate() {
}
