import { parseTree, printParseErrorCode, modify, type Node, type ParseError } from 'jsonc-parser';

export type KeyPath = string[];
export type IssueCode = 'json' | 'root' | 'duplicate' | 'value' | 'empty' | 'missing' | 'extra' | 'placeholder';
export type PlaceholderStyle = 'auto' | 'i18next' | 'braces' | 'none';

export interface Location {
  offset: number;
  length: number;
}

export interface Entry extends Location {
  path: KeyPath;
  value: string;
}

export interface Issue extends Location {
  code: IssueCode;
  message: string;
  path?: KeyPath;
  reference?: Location;
}

export interface Catalog {
  entries: Map<string, Entry>;
  objects: Map<string, Location>;
  issues: Issue[];
  valid: boolean;
}

export const keyId = (path: KeyPath): string => JSON.stringify(path);

export function displayKey(path: KeyPath): string {
  return path.map((part, index) => /^[A-Za-z_$][\w$-]*$/.test(part)
    ? `${index ? '.' : ''}${part}`
    : `[${JSON.stringify(part)}]`).join('');
}

function location(node: Node): Location {
  return { offset: node.offset, length: node.length };
}

export function parseCatalog(text: string): Catalog {
  let depth = 0, quoted = false, escaped = false;
  for (let offset = 0; offset < text.length; offset++) {
    const character = text[offset];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === '{' || character === '[') {
      if (++depth > 64) return {
        entries: new Map(), objects: new Map(), valid: false,
        issues: [{ code: 'json', message: 'JSON nesting exceeds 64 levels.', offset, length: 1 }],
      };
    } else if (character === '}' || character === ']') depth = Math.max(0, depth - 1);
  }
  const errors: ParseError[] = [];
  // Keep offsets intact when a file starts with a UTF-8 byte-order mark.
  const input = text.startsWith('\uFEFF') ? ` ${text.slice(1)}` : text;
  const root = parseTree(input, errors, { disallowComments: true, allowTrailingComma: false });
  const catalog: Catalog = { entries: new Map(), objects: new Map(), issues: [], valid: true };

  if (errors.length || !root) {
    catalog.valid = false;
    catalog.issues = errors.length ? errors.map(error => ({
      code: 'json', message: `Invalid JSON: ${printParseErrorCode(error.error)}.`,
      offset: error.offset, length: Math.max(1, error.length),
    })) : [{ code: 'json', message: 'Expected a JSON object.', offset: 0, length: 1 }];
    return catalog;
  }
  if (root.type !== 'object') {
    return { ...catalog, valid: false, issues: [{ code: 'root', message: 'The catalog must be a JSON object.', ...location(root) }] };
  }

  function visit(object: Node, path: KeyPath): void {
    catalog.objects.set(keyId(path), { offset: object.offset, length: 1 });
    const seen = new Set<string>();
    for (const property of object.children ?? []) {
      const [key, value] = property.children ?? [];
      if (!key || !value) continue;
      const next = [...path, String(key.value)];
      const label = displayKey(next);
      if (seen.has(key.value)) {
        catalog.valid = false;
        catalog.issues.push({ code: 'duplicate', message: `Duplicate key: ${label}.`, path: next, ...location(key) });
        continue;
      }
      seen.add(key.value);
      if (value.type === 'object') {
        visit(value, next);
      } else if (value.type === 'string') {
        catalog.entries.set(keyId(next), { path: next, value: value.value, ...location(key) });
        if (value.value.trim() === '') {
          catalog.issues.push({ code: 'empty', message: `Empty translation: ${label}.`, path: next, ...location(value) });
        }
      } else {
        catalog.valid = false;
        catalog.issues.push({ code: 'value', message: `Expected a string or an object at ${label}.`, path: next, ...location(value) });
      }
    }
  }

  visit(root, []);
  return catalog;
}

export function placeholders(value: string, style: PlaceholderStyle = 'auto'): Set<string> {
  const names = new Set<string>();
  if (style === 'none') return names;
  if (style !== 'braces') {
    value = value.replace(/\{\{\s*-?\s*([A-Za-z_$][\w.$-]*)\s*(?:,[^{}]+)?\}\}/g, (_, name: string) => { names.add(name); return ''; });
  }
  if (style !== 'i18next') {
    for (const match of value.matchAll(/(?<![\\{])\{([A-Za-z_$][\w.$-]*)\}(?!\})/g)) names.add(match[1]!);
  }
  return names;
}

export function compareCatalogs(reference: Catalog, target: Catalog, style: PlaceholderStyle = 'auto'): Issue[] {
  if (!reference.valid || !target.valid) return [];
  const issues: Issue[] = [];
  for (const [id, entry] of reference.entries) {
    const translated = target.entries.get(id);
    if (translated) {
      if (!translated.value.trim()) continue; // Already reported as an empty translation.
      const expected = placeholders(entry.value, style), actual = placeholders(translated.value, style);
      const missing = [...expected].filter(name => !actual.has(name)).sort();
      const extra = [...actual].filter(name => !expected.has(name)).sort();
      if (missing.length || extra.length) issues.push({
        code: 'placeholder', path: translated.path, offset: translated.offset, length: translated.length,
        message: `Placeholder mismatch at ${displayKey(entry.path)}: ${[missing.length ? `missing ${missing.join(', ')}` : '', extra.length ? `unexpected ${extra.join(', ')}` : ''].filter(Boolean).join('; ')}.`,
        reference: { offset: entry.offset, length: entry.length },
      });
      continue;
    }
    let parent = entry.path.slice(0, -1);
    while (parent.length && !target.objects.has(keyId(parent))) parent = parent.slice(0, -1);
    issues.push({
      code: 'missing', path: entry.path, message: `Missing translation: ${displayKey(entry.path)}.`,
      ...(target.objects.get(keyId(parent)) ?? { offset: 0, length: 1 }),
      reference: { offset: entry.offset, length: entry.length },
    });
  }
  for (const [id, entry] of target.entries) {
    if (!reference.entries.has(id)) {
      issues.push({ code: 'extra', path: entry.path, message: `Key is not in the reference: ${displayKey(entry.path)}.`, offset: entry.offset, length: entry.length });
    }
  }
  return issues;
}

export function canInsert(catalog: Catalog, path: KeyPath): boolean {
  if (!catalog.valid || !path.length || catalog.entries.has(keyId(path)) || catalog.objects.has(keyId(path))) return false;
  for (let length = 1; length < path.length; length++) {
    if (catalog.entries.has(keyId(path.slice(0, length)))) return false;
  }
  return true;
}

export function missingKeyEdits(text: string, path: KeyPath, insertSpaces: boolean, tabSize: number) {
  if (!canInsert(parseCatalog(text), path)) return [];
  return modify(text, path, '', {
    formattingOptions: { insertSpaces, tabSize, eol: text.includes('\r\n') ? '\r\n' : '\n' },
  });
}
