const assert = require('node:assert/strict');
const vscode = require('vscode');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const ownDiagnostics = uri => vscode.languages.getDiagnostics(uri).filter(d => d.source === 'LocaleLens');

async function until(check, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  assert.fail(message);
}

async function replace(document, text) {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
  assert.equal(await vscode.workspace.applyEdit(edit), true);
}

exports.run = async () => {
  const extension = vscode.extensions.getExtension('Almeida96.localelens');
  assert.ok(extension, 'Extension is available');
  await extension.activate();
  const [first, second] = vscode.workspace.workspaceFolders;
  const target = vscode.Uri.joinPath(first.uri, 'locales', 'pt-BR.json');
  const reference = vscode.Uri.joinPath(first.uri, 'locales', 'en.json');
  const other = vscode.Uri.joinPath(second.uri, 'translations', 'es.json');
  await vscode.commands.executeCommand('localeLens.refresh');
  await until(() => ownDiagnostics(target).length === 3, 'Initial comparison did not produce three diagnostics');
  assert.deepEqual(ownDiagnostics(target).map(d => d.code).sort(), ['empty', 'extra', 'missing']);
  assert.equal(ownDiagnostics(other)[0]?.code, 'missing', 'Each workspace folder uses its own settings');
  console.log('PASS diagnostics and per-folder settings');

  const missing = ownDiagnostics(target).find(d => d.code === 'missing');
  assert.equal(missing.range.start.line, 1);
  assert.equal(missing.relatedInformation[0].location.uri.toString(), reference.toString());
  const document = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(document);
  let action;
  await until(async () => {
    const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', target, missing.range);
    action = actions.find(action => action.title === 'Add menu.close with an empty value');
    return Boolean(action?.edit);
  }, 'Missing key has no actionable quick fix');
  assert.equal(await vscode.workspace.applyEdit(action.edit), true);
  await until(() => !ownDiagnostics(target).some(d => d.code === 'missing'), 'Quick fix did not clear the missing-key diagnostic');
  assert.equal(JSON.parse(document.getText()).menu.close, '');
  assert.equal(JSON.parse(document.getText()).menu.save, 'Salvar');
  assert.equal(ownDiagnostics(target).filter(d => d.code === 'empty').length, 2);
  console.log('PASS quick fix and unsaved edits');

  await replace(document, '{"menu":{"save":"Salvar","close":"Fechar"},"title":"Olá"}');
  await until(() => ownDiagnostics(target).length === 0, 'Completed catalog still has diagnostics');
  await replace(document, '{"menu":');
  await until(() => ownDiagnostics(target).some(d => d.code === 'json'), 'Invalid JSON was not reported');
  assert.ok(ownDiagnostics(target).every(d => d.code === 'json'));
  console.log('PASS invalid JSON suppresses comparison noise');

  await replace(document, '{"menu":"Menu","title":"Olá"}');
  await until(() => ownDiagnostics(target).filter(d => d.code === 'missing').length === 2, 'Structural conflict was not reported');
  const blocked = ownDiagnostics(target).find(d => d.code === 'missing');
  const blockedActions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', target, blocked.range);
  assert.ok(!blockedActions.some(action => action.title.startsWith('Add menu.')), 'Quick fix must not overwrite a scalar parent');
  console.log('PASS conflicting parent is not overwritten');

  await replace(document, '{"menu":{"save":"Salvar","close":"Fechar"},"title":"Olá"}');
  await document.save();
  const referenceDocument = await vscode.workspace.openTextDocument(reference);
  await replace(referenceDocument, '{"title":"Hello","title":"Duplicate"}');
  await until(() => ownDiagnostics(reference).some(d => d.code === 'duplicate'), 'Reference duplicate was not reported');
  assert.equal(ownDiagnostics(target).length, 0, 'Invalid reference must not produce comparison results');
  await replace(referenceDocument, '{"menu":{"save":"Save","close":"Close"},"title":"Hello"}');
  await referenceDocument.save();
  console.log('PASS invalid reference handling');

  const added = vscode.Uri.joinPath(first.uri, 'locales', 'fr.json');
  await vscode.workspace.fs.writeFile(added, Buffer.from('{}'));
  await until(() => ownDiagnostics(added).filter(d => d.code === 'missing').length === 3, 'Created file was not picked up by the watcher');
  await vscode.workspace.fs.writeFile(added, Buffer.from('{"menu":{"save":"Enregistrer","close":"Fermer"},"title":"Bonjour"}'));
  await until(() => ownDiagnostics(added).length === 0, 'An external file edit did not refresh diagnostics');
  await vscode.workspace.fs.writeFile(added, Buffer.from('{}'));
  await until(() => ownDiagnostics(added).length === 3, 'An external edit did not restore missing diagnostics');
  await vscode.workspace.fs.delete(added);
  await until(() => ownDiagnostics(added).length === 0, 'Deleted file left stale diagnostics');
  console.log('PASS external edits, file creation and deletion');

  const config = vscode.workspace.getConfiguration('localeLens', first.uri);
  await replace(referenceDocument, '{"menu":{"save":"Save","close":"Close"},"title":"Hello {{name}}"}');
  await replace(document, '{"menu":{"save":"Salvar","close":"Fechar"},"title":"Olá {{nome}}"}');
  await until(() => ownDiagnostics(target).some(d => d.code === 'placeholder'), 'A renamed parameter was not reported');
  const parameter = ownDiagnostics(target).find(d => d.code === 'placeholder');
  assert.equal(parameter.severity, vscode.DiagnosticSeverity.Warning);
  assert.equal(parameter.relatedInformation[0].location.uri.toString(), reference.toString());
  await config.update('placeholders', 'none', vscode.ConfigurationTarget.WorkspaceFolder);
  await until(() => ownDiagnostics(target).length === 0, 'Disabling placeholder checks did not clear the diagnostic');
  await config.update('placeholders', 'auto', vscode.ConfigurationTarget.WorkspaceFolder);
  await until(() => ownDiagnostics(target).some(d => d.code === 'placeholder'), 'Re-enabling placeholder checks did not restore the diagnostic');
  await replace(referenceDocument, '{"menu":{"save":"Save","close":"Close"},"title":"Hello"}');
  await referenceDocument.save();
  console.log('PASS interpolation diagnostics and syntax configuration');
  await replace(document, '{}');
  await until(() => ownDiagnostics(target).length === 3, 'Expected missing keys before disabling the folder');
  await config.update('enabled', false, vscode.ConfigurationTarget.WorkspaceFolder);
  await until(() => ownDiagnostics(target).length === 0 && ownDiagnostics(reference).length === 0, 'Disabled folder still has diagnostics');
  assert.equal(ownDiagnostics(other)[0]?.code, 'missing', 'Disabling one folder must not disable the other');
  await config.update('enabled', true, vscode.ConfigurationTarget.WorkspaceFolder);
  await until(() => ownDiagnostics(target).length === 3, 'Re-enabling the folder did not restore diagnostics');
  await config.update('referenceLocale', 'does-not-exist', vscode.ConfigurationTarget.WorkspaceFolder);
  await until(() => ownDiagnostics(target).length === 0, 'Missing reference left stale diagnostics');
  console.log('PASS configuration changes');
};
