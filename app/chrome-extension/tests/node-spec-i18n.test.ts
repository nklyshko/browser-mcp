/**
 * Node spec i18n tests
 * @description The builtin NodeSpecs hold message keys rather than literals so
 * the shared package stays free of chrome.* (see node-specs-builtin.ts). That
 * indirection fails silently in the UI — a key missing from _locales renders as
 * the bare key text in the builder's sidebar and property panels. These tests
 * pin both halves: every key the specs ask for exists, and the two locales stay
 * in sync so a key added to one is never forgotten in the other.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  registerBuiltinSpecs,
  listNodeSpecs,
} from '../entrypoints/popup/components/builder/model/node-specs-builtin';

const localeDir = resolve(__dirname, '../_locales');
const readLocale = (locale: string): Record<string, { message: string }> =>
  JSON.parse(readFileSync(resolve(localeDir, locale, 'messages.json'), 'utf8'));

const en = readLocale('en');
const zhCN = readLocale('zh_CN');

/** Collects every key the specs pass to the translator. */
function collectRequestedKeys(): string[] {
  const requested: string[] = [];
  registerBuiltinSpecs((key) => {
    requested.push(key);
    return key;
  });
  return requested;
}

describe('registerBuiltinSpecs', () => {
  it('only asks for keys that exist in the English catalogue', () => {
    const missing = [...new Set(collectRequestedKeys())].filter((key) => !(key in en)).sort();
    expect(missing).toEqual([]);
  });

  it('registers specs whose labels all resolve to real text', () => {
    registerBuiltinSpecs((key) => en[key]?.message ?? key);
    const specs = listNodeSpecs();
    expect(specs.length).toBeGreaterThan(0);
    // A label equal to its own key means the lookup fell through.
    const unresolved = specs
      .map((spec) => spec.display?.label)
      .filter((label): label is string => typeof label === 'string' && /^spec[A-Z]/.test(label));
    expect(unresolved).toEqual([]);
  });

  it('requests no key the specs do not define text for in Chinese', () => {
    const missing = [...new Set(collectRequestedKeys())].filter((key) => !(key in zhCN)).sort();
    expect(missing).toEqual([]);
  });
});

describe('_locales', () => {
  it('keeps en and zh_CN on the same key set', () => {
    const onlyEn = Object.keys(en)
      .filter((key) => !(key in zhCN))
      .sort();
    const onlyZh = Object.keys(zhCN)
      .filter((key) => !(key in en))
      .sort();
    expect({ onlyEn, onlyZh }).toEqual({ onlyEn: [], onlyZh: [] });
  });

  it('has no Chinese text left in the English catalogue', () => {
    const withHan = Object.entries(en)
      .filter(([, value]) => /\p{Script=Han}/u.test(value.message))
      .map(([key]) => key)
      .sort();
    expect(withHan).toEqual([]);
  });

  it('defines every key the source asks for by name', () => {
    // A missing key is not an error at runtime: getMessage returns the key
    // itself, so the UI quietly renders "opStateRunning" instead of "Running".
    // Only literal call sites are checked — keys built by template literal
    // (opAction_${tool}) fall back to a derived label on purpose.
    const root = resolve(__dirname, '..');
    const sources = execFileSync(
      'git',
      ['grep', '-lz', '--', 'getMessage', ':(exclude)tests', ':(exclude)_locales'],
      { cwd: root, encoding: 'utf8' },
    )
      .split('\0')
      .filter(Boolean);
    expect(sources.length).toBeGreaterThan(0);

    const missing = new Map<string, string[]>();
    for (const file of sources) {
      const text = readFileSync(resolve(root, file), 'utf8');
      for (const [, key] of text.matchAll(/\bgetMessage\(\s*'([A-Za-z0-9_@]+)'/g)) {
        if (key in en) continue;
        missing.set(key, [...(missing.get(key) ?? []), file]);
      }
    }
    expect(Object.fromEntries(missing)).toEqual({});
  });
});
