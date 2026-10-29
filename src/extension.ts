import * as vscode from 'vscode';
import { parseCatalog, compareCatalogs, canInsert, displayKey, missingKeyEdits, type Catalog, type Issue, type PlaceholderStyle } from './catalog';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 200;

interface FileResult {
  uri: vscode.Uri;
  document?: vscode.TextDocument;
  version?: number;
  catalog?: Catalog;
  issues: Issue[];
  diagnostics: vscode.Diagnostic[];
  error?: string;
}

interface FolderResult {
  name: string;
  uri: vscode.Uri;
  message: string;
  files: FileResult[];
}

type Row = { kind: 'folder'; folder: FolderResult }
  | { kind: 'file'; file: FileResult }
  | { kind: 'issue'; file: FileResult; issue: Issue; index: number }
  | { kind: 'message'; message: string };

function rangeFor(document: vscode.TextDocument, issue: { offset: number; length: number }): vscode.Range {
  return new vscode.Range(document.positionAt(issue.offset), document.positionAt(issue.offset + issue.length));
}

function fileName(uri: vscode.Uri): string {
  return uri.path.slice(uri.path.lastIndexOf('/') + 1);
}

function uriKey(uri: vscode.Uri): string {
  const key = uri.toString();
  return process.platform === 'win32' && uri.scheme === 'file' ? key.toLowerCase() : key;
}

class ResultsTree implements vscode.TreeDataProvider<Row>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Row | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  folders: FolderResult[] = [];

  update(folders: FolderResult[]): void {
    this.folders = folders;
    this.changed.fire(undefined);
  }

  getChildren(row?: Row): Row[] {
    if (!row) return this.folders.length
      ? this.folders.map(folder => ({ kind: 'folder', folder }))
      : [{ kind: 'message', message: 'Open a folder to check translations.' }];
    if (row.kind === 'folder') {
      const files = row.folder.files.filter(file => file.issues.length || file.error);
      return files.length ? files.map(file => ({ kind: 'file', file }))
        : [{ kind: 'message', message: row.folder.message }];
    }
    if (row.kind === 'file') {
      return row.file.error ? [{ kind: 'message', message: row.file.error }]
        : row.file.issues.map((issue, index) => ({ kind: 'issue', file: row.file, issue, index }));
    }
    return [];
  }

  getTreeItem(row: Row): vscode.TreeItem {
    if (row.kind === 'message') {
      const item = new vscode.TreeItem(row.message);
      item.iconPath = new vscode.ThemeIcon('info');
      item.tooltip = row.message;
      return item;
    }
    if (row.kind === 'folder') {
      const item = new vscode.TreeItem(row.folder.name, vscode.TreeItemCollapsibleState.Expanded);
      item.id = row.folder.uri.toString();
      item.description = row.folder.message;
      item.tooltip = row.folder.message;
      item.iconPath = new vscode.ThemeIcon('globe');
      return item;
    }
    if (row.kind === 'file') {
      const item = new vscode.TreeItem(fileName(row.file.uri), vscode.TreeItemCollapsibleState.Expanded);
      item.id = row.file.uri.toString();
      item.resourceUri = row.file.uri;
      item.description = row.file.error ? 'Could not read file' : `${row.file.issues.length} issues`;
      item.iconPath = new vscode.ThemeIcon('file-code');
      return item;
    }
    const item = new vscode.TreeItem(row.issue.path ? displayKey(row.issue.path) : row.issue.message);
    item.description = row.issue.code;
    item.tooltip = row.issue.message;
    item.iconPath = new vscode.ThemeIcon(row.issue.code === 'extra' ? 'diff-added' : 'warning');
    item.command = {
      command: 'vscode.open', title: 'Open translation',
      arguments: [row.file.uri, { selection: row.file.diagnostics[row.index]?.range }],
    };
    return item;
  }

  dispose(): void { this.changed.dispose(); }
}

class LocaleLens implements vscode.CodeActionProvider, vscode.Disposable {
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('LocaleLens');
  private readonly tree = new ResultsTree();
  private readonly view = vscode.window.createTreeView('localeLens.results', { treeDataProvider: this.tree });
  private readonly output = vscode.window.createOutputChannel('LocaleLens');
  private readonly disposables: vscode.Disposable[] = [];
  private watchers: vscode.FileSystemWatcher[] = [];
  private directories = new Set<string>();
  private files = new Map<string, FileResult>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private revision = 0;
  private disposed = false;

  constructor() {
    this.disposables.push(
      vscode.commands.registerCommand('localeLens.refresh', () => this.refresh()),
      vscode.commands.registerCommand('localeLens.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:Almeida96.localelens')),
      vscode.languages.registerCodeActionsProvider([{ language: 'json' }, { language: 'jsonc' }], this, {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
      }),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (this.isCatalog(event.document.uri)) this.schedule();
      }),
      vscode.workspace.onDidCloseTextDocument(document => {
        if (this.isCatalog(document.uri)) this.schedule();
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('localeLens')) this.reconfigure();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.reconfigure()),
    );
    this.reconfigure();
  }

  private settings(folder: vscode.WorkspaceFolder): { directory: vscode.Uri; reference: string; placeholders: PlaceholderStyle } | string {
    const config = vscode.workspace.getConfiguration('localeLens', folder.uri);
    if (!config.get<boolean>('enabled', true)) return 'Disabled in this folder.';
    const configuredPath = config.get<string>('directory', 'locales');
    if (typeof configuredPath !== 'string') return 'Set localeLens.directory to a directory inside this workspace folder.';
    const path = configuredPath.replace(/\\/g, '/');
    const reference = config.get<string>('referenceLocale', 'en');
    if (!path || path.startsWith('/') || path.includes(':') || path.split('/').includes('..')) {
      return 'Set localeLens.directory to a directory inside this workspace folder.';
    }
    if (typeof reference !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(reference)) return 'Set localeLens.referenceLocale to a file name such as en or en-GB.';
    const placeholders = config.get<PlaceholderStyle>('placeholders', 'auto');
    if (!['auto', 'none', 'braces', 'i18next'].includes(placeholders)) return 'Set localeLens.placeholders to auto, braces, i18next, or none.';
    return { directory: vscode.Uri.joinPath(folder.uri, path), reference: `${reference}.json`, placeholders };
  }

  private reconfigure(): void {
    this.watchers.forEach(watcher => watcher.dispose());
    this.watchers = [];
    this.directories.clear();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const settings = this.settings(folder);
      if (typeof settings === 'string') continue;
      this.directories.add(uriKey(settings.directory));
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(settings.directory, '*'));
      watcher.onDidCreate(() => this.schedule());
      watcher.onDidChange(() => this.schedule());
      watcher.onDidDelete(() => this.schedule());
      this.watchers.push(watcher);
    }
    this.schedule(0);
  }

  private isCatalog(uri: vscode.Uri): boolean {
    return uri.path.endsWith('.json') && this.directories.has(uriKey(vscode.Uri.joinPath(uri, '..')));
  }

  private schedule(delay = 250): void {
    if (this.disposed) return;
    this.revision++;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.refresh(); }, delay);
  }

  async refresh(): Promise<void> {
    if (this.disposed) return;
    clearTimeout(this.timer);
    const revision = ++this.revision;
    try {
      const folders: FolderResult[] = [];
      for (const folder of vscode.workspace.workspaceFolders ?? []) folders.push(await this.scanFolder(folder));
      if (this.disposed || revision !== this.revision) return;
      const files = new Map<string, FileResult>();
      this.diagnostics.clear();
      for (const folder of folders) {
        for (const file of folder.files) {
          files.set(uriKey(file.uri), file);
          this.diagnostics.set(file.uri, file.diagnostics);
        }
      }
      this.files = files;
      this.tree.update(folders);
      const count = folders.reduce((sum, folder) => sum + folder.files.reduce((n, file) => n + file.issues.length, 0), 0);
      this.view.badge = count ? { value: count, tooltip: `${count} translation issues` } : undefined;
    } catch (error) {
      if (this.disposed || revision !== this.revision) return;
      this.diagnostics.clear();
      this.files.clear();
      this.output.appendLine(`Scan failed: ${error instanceof Error ? error.message : String(error)}`);
      this.tree.update([{ name: 'LocaleLens', uri: vscode.Uri.parse('localelens:/error'), message: 'Scan failed. See the LocaleLens output channel.', files: [] }]);
    }
  }

  private async readFile(uri: vscode.Uri): Promise<FileResult> {
    const result: FileResult = { uri, issues: [], diagnostics: [] };
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_FILE_BYTES) return { ...result, error: 'File exceeds the 1 MiB size limit.' };
      const document = await vscode.workspace.openTextDocument(uri);
      const text = document.getText();
      if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) return { ...result, error: 'File exceeds the 1 MiB size limit.' };
      result.document = document;
      result.version = document.version;
      result.catalog = parseCatalog(text);
      result.issues = [...result.catalog.issues];
    } catch {
      result.error = 'Could not read this file. Check its permissions and try Refresh.';
    }
    return result;
  }

  private async scanFolder(folder: vscode.WorkspaceFolder): Promise<FolderResult> {
    const result: FolderResult = { name: folder.name, uri: folder.uri, message: '', files: [] };
    const settings = this.settings(folder);
    if (typeof settings === 'string') return { ...result, message: settings };
    let names: string[];
    try {
      names = (await vscode.workspace.fs.readDirectory(settings.directory))
        .filter(([name, type]) => (type & vscode.FileType.File) !== 0 && name.endsWith('.json'))
        .map(([name]) => name).sort();
    } catch (error) {
      return { ...result, message: error instanceof vscode.FileSystemError && error.code === 'FileNotFound'
        ? 'No locale directory. Choose one in LocaleLens settings.'
        : 'Could not read the locale directory. Check the path and permissions.' };
    }
    if (names.length > MAX_FILES) return { ...result, message: `This directory has more than ${MAX_FILES} JSON files. Choose a smaller catalog directory.` };
    if (!names.includes(settings.reference)) return { ...result, message: `Reference file ${settings.reference} was not found. Check LocaleLens settings.` };
    const referenceUri = vscode.Uri.joinPath(settings.directory, settings.reference);
    const reference = await this.readFile(referenceUri);
    result.files.push(reference);
    for (const name of names) {
      if (name === settings.reference) continue;
      const file = await this.readFile(vscode.Uri.joinPath(settings.directory, name));
      if (reference.catalog && file.catalog) file.issues.push(...compareCatalogs(reference.catalog, file.catalog, settings.placeholders));
      result.files.push(file);
    }
    for (const file of result.files) {
      if (!file.document) continue;
      file.diagnostics = file.issues.map(issue => {
        const severity = ['json', 'root', 'duplicate', 'value'].includes(issue.code)
          ? vscode.DiagnosticSeverity.Error : issue.code === 'extra' ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Warning;
        const diagnostic = new vscode.Diagnostic(rangeFor(file.document!, issue), issue.message, severity);
        diagnostic.source = 'LocaleLens';
        diagnostic.code = issue.code;
        if (issue.reference && reference.document) {
          diagnostic.relatedInformation = [new vscode.DiagnosticRelatedInformation(
            new vscode.Location(referenceUri, rangeFor(reference.document, issue.reference)),
            `Defined in ${settings.reference}.`,
          )];
        }
        return diagnostic;
      });
    }
    const issues = result.files.reduce((sum, file) => sum + file.issues.length, 0);
    const unreadable = result.files.filter(file => file.error).length;
    result.message = !reference.catalog?.valid ? 'Fix the reference file to compare keys.'
      : unreadable ? `${unreadable} files could not be checked.`
      : names.length === 1 ? 'Add another locale JSON file to compare keys.'
      : issues ? `${issues} issues · reference: ${settings.reference}`
      : `${names.length - 1} locales match ${settings.reference}.`;
    return result;
  }

  provideCodeActions(document: vscode.TextDocument, _range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
    const file = this.files.get(uriKey(document.uri));
    if (!file?.catalog || file.version !== document.version) return [];
    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== 'LocaleLens' || diagnostic.code !== 'missing') continue;
      const issue = file.issues.find(candidate => candidate.code === 'missing' && candidate.message === diagnostic.message);
      if (!issue?.path || !canInsert(file.catalog, issue.path)) continue;
      const action = new vscode.CodeAction(`Add ${displayKey(issue.path)} with an empty value`, vscode.CodeActionKind.QuickFix);
      const editor = vscode.window.visibleTextEditors.find(editor => uriKey(editor.document.uri) === uriKey(document.uri));
      const config = vscode.workspace.getConfiguration('editor', document);
      const spaces = editor?.options.insertSpaces ?? config.get<boolean>('insertSpaces', true);
      const size = editor?.options.tabSize ?? config.get<number>('tabSize', 2);
      const edits = missingKeyEdits(document.getText(), issue.path, spaces !== false, typeof size === 'number' ? size : 2);
      if (!edits.length) continue;
      action.edit = new vscode.WorkspaceEdit();
      action.edit.set(document.uri, edits.map(edit => vscode.TextEdit.replace(
        rangeFor(document, { offset: edit.offset, length: edit.length }), edit.content,
      )));
      action.diagnostics = [diagnostic];
      actions.push(action);
    }
    return actions;
  }

  dispose(): void {
    this.disposed = true;
    this.revision++;
    clearTimeout(this.timer);
    for (const disposable of [...this.disposables, ...this.watchers, this.view, this.tree, this.diagnostics, this.output]) disposable.dispose();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(new LocaleLens());
}
