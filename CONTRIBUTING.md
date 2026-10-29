# Contributing

Use Node.js 22 or later and pnpm 11.25.0.

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm test
pnpm run test:extension
pnpm run package
```

Keep parser and comparison changes in `src/catalog.ts`, with regression tests in `test/core.test.cjs`. Changes to diagnostics, watchers, or editor actions should also have an extension-host test in `test/extension.cjs`.

For bug reports, include the VS Code version, relevant LocaleLens settings, and the smallest pair of locale files that reproduces the problem. Replace private strings before sharing files.

For pull requests, describe the behavior that changed and the checks you ran. Avoid unrelated formatting changes.
