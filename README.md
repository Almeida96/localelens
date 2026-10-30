# LocaleLens

[![CI](https://github.com/Almeida96/localelens/actions/workflows/ci.yml/badge.svg)](https://github.com/Almeida96/localelens/actions/workflows/ci.yml)

Find missing keys, empty translations, and mismatched interpolation parameters in VS Code.

LocaleLens compares JSON locale files against a reference file. Results appear in the Explorer sidebar and the Problems panel, and update as you edit.

```text
locales/
  en.json       reference
  es.json       all keys present
  pt-BR.json    menu.close is missing
                title is empty
                old is not in the reference
```

## Install

Requires VS Code 1.96 or later. This version is distributed as a local VSIX package.

Build the package from this repository:

```sh
pnpm install --frozen-lockfile
pnpm run package
code --install-extension localelens-0.2.0.vsix
```

You can also run **Extensions: Install from VSIX...** from the VS Code Command Palette and select the file. Building requires Node.js 22 or later and pnpm 11.25.0; using the installed extension does not require either.

## Use

1. Open a folder containing `locales/en.json` and at least one other locale, such as `locales/pt-BR.json`.
2. Expand **LocaleLens** in the Explorer sidebar, or open the **Problems** panel.
3. Click a result to open its location. For a missing key, use the lightbulb action to add an empty value, then write the translation.

Open `examples/demo` in VS Code to try it. The Portuguese catalog has three intentional issues; the Spanish catalog matches the reference.

For a different directory or reference language, add these settings to `.vscode/settings.json`:

```json
{
  "localeLens.directory": "src/translations",
  "localeLens.referenceLocale": "en-GB"
}
```

The directory is relative to the workspace folder. Each workspace folder can have its own settings. Set `localeLens.enabled` to `false` to disable checks for a folder. **LocaleLens: Refresh** runs a scan manually.

## What gets checked

| Finding | Where it appears |
| --- | --- |
| Missing key | Warning on the nearest parent object, with a link to the reference key |
| Extra key | Information on the key that is absent from the reference |
| Empty or whitespace-only value | Warning on the value |
| Missing or renamed interpolation parameter | Warning on the translation key, linked to the reference |
| Invalid JSON, duplicate key, or unsupported value | Error at the affected location |

Nested objects are supported. `{"menu":{"save":"Save"}}` and `{"menu.save":"Save"}` contain different keys. Empty objects count as groups, not translations.

The quick fix inserts one missing key with `""` as its value and preserves the file's indentation and line endings. It creates parent objects when needed. It is unavailable when an existing value or object would need to be replaced. Empty values remain flagged until translated.

If a file has syntax errors, duplicate keys, or unsupported values, comparisons involving that file pause until it is fixed. An invalid reference pauses key comparisons across that folder. The extension still reports local errors and empty values.

## Interpolation parameters

`"Hello {{name}}"` and `"Olá {{nome}}"` have matching keys but use different parameters. LocaleLens reports the missing `name` and unexpected `nome` before this reaches the UI. Parameter order and repetition may differ; names remain case-sensitive.

The default `localeLens.placeholders: "auto"` checks `{name}`, `{{name}}`, `{{user.name}}`, i18next formatters such as `{{amount, currency}}`, and unescaped i18next values such as `{{- html}}`. Select `"braces"` or `"i18next"` to restrict the syntax, or `"none"` when braces are literal text. This setting is per workspace folder and updates diagnostics immediately.

This is a named-parameter check, not an ICU MessageFormat parser. ICU plural/select branches and framework-specific escape rules are outside its scope. Empty translations receive only their existing empty-value warning.

## Scope

- One reference catalog per workspace folder, with one `.json` file per locale in the same directory.
- Strict JSON with strings and nested objects. Comments, trailing commas, arrays, numbers, booleans, and null values are not supported.
- Only files directly inside the configured directory are checked. There is a limit of 200 JSON files per directory, 1 MiB per file and 64 nested containers. Deeper input produces a diagnostic before recursive parsing.
- Keys are compared exactly. LocaleLens does not check translation quality, plural rules, or references from application code.
- Unsaved changes are included. Files are changed only when you apply a quick fix.

LocaleLens has no telemetry or network calls. It reads the configured locale files through the VS Code workspace API.

## Development

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm test
pnpm run test:extension
pnpm run package
```

Press **F5** in this repository to open an Extension Development Host with the demo folder. The build task runs before launch.

Unit tests cover parsing, key comparison, source locations, and edits. Extension tests run in an isolated VS Code profile with temporary workspace folders. They cover diagnostics, quick fixes, unsaved edits, file changes, and folder settings. The test runner downloads VS Code by default; set `VSCODE_EXECUTABLE_PATH` to use an installed executable, or `VSCODE_TEST_VERSION` to choose a version. Linux environments without a display need `xvfb-run -a pnpm run test:extension`.

Source code lives in `src/`. The runtime and its JSON parser are bundled into `dist/extension.cjs`; the VSIX does not ship development dependencies or test fixtures.

## License

MIT. The repository and VSIX include `LICENSE` and `THIRD_PARTY_NOTICES.md`.
