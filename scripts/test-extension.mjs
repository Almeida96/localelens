import { runTests } from '@vscode/test-electron';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const root = resolve('.');
await mkdir(join(root, '.vscode-test'), { recursive: true });
const fixture = await mkdtemp(join(root, '.vscode-test', 'fixture-'));
const first = join(fixture, 'app');
const second = join(fixture, 'admin');
await mkdir(join(first, 'locales'), { recursive: true });
await mkdir(join(second, 'translations'), { recursive: true });
await mkdir(join(second, '.vscode'), { recursive: true });
await writeFile(join(first, 'locales', 'en.json'), JSON.stringify({ menu: { save: 'Save', close: 'Close' }, title: 'Hello' }, null, 2));
await writeFile(join(first, 'locales', 'pt-BR.json'), JSON.stringify({ menu: { save: 'Salvar' }, title: '', old: 'Old' }, null, 2));
await writeFile(join(second, 'translations', 'pt.json'), '{"hello":"Olá"}');
await writeFile(join(second, 'translations', 'es.json'), '{}');
await writeFile(join(second, '.vscode', 'settings.json'), JSON.stringify({ 'localeLens.directory': 'translations', 'localeLens.referenceLocale': 'pt' }));
const workspace = join(fixture, 'test.code-workspace');
await writeFile(workspace, JSON.stringify({ folders: [{ path: first }, { path: second }] }));

await runTests({
  extensionDevelopmentPath: root,
  extensionTestsPath: join(root, 'test', 'extension.cjs'),
  vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH,
  version: process.env.VSCODE_TEST_VERSION || 'stable',
  launchArgs: [
    workspace, '--disable-extensions', '--disable-workspace-trust',
    '--skip-welcome', '--skip-release-notes', '--disable-updates', '--disable-gpu',
    `--user-data-dir=${join(fixture, 'user-data')}`,
    `--extensions-dir=${join(fixture, 'extensions')}`,
  ],
});
