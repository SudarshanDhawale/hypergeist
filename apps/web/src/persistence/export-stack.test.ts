import { describe, expect, it } from 'vitest';
import { parseStack } from '@hypergeist/shared/format';
import type { Stack } from '@hypergeist/shared/format';
import demoText from '../stacks/thin-slice-todo.json?raw';
import { exportFilename, exportStack } from './export-stack.ts';

const parsed = parseStack(demoText);
if (!parsed.ok) throw new Error('the Demo_Stack must be valid');
const demo: Stack = parsed.value;

describe('exportFilename', () => {
  it('joins a normal name and the id', () => {
    expect(exportFilename('Thin slice to-do', 'thin-slice-todo')).toBe(
      'thin-slice-to-do-thin-slice-todo.hypergeist.json',
    );
  });

  it('lower-cases and collapses runs of other characters into one dash', () => {
    expect(exportFilename('  My   Stack!!  v2 ', 'abc')).toBe('my-stack-v2-abc.hypergeist.json');
  });

  it('gives only the id for a non-Latin name', () => {
    expect(exportFilename('日本語のスタック', 'jp-1')).toBe('jp-1.hypergeist.json');
    expect(exportFilename('Привет мир', 'ru')).toBe('ru.hypergeist.json');
  });

  it('keeps the Latin part of a mixed name', () => {
    expect(exportFilename('Café Ünïcode', 'x')).toBe('caf-n-code-x.hypergeist.json');
  });

  it('drops emoji', () => {
    expect(exportFilename('📚 Study 🎓 deck', 'study')).toBe('study-deck-study.hypergeist.json');
    expect(exportFilename('👻👻👻', 'ghost')).toBe('ghost.hypergeist.json');
  });

  it('cuts a 100-character name to a 40-character slug', () => {
    const name = 'a'.repeat(100);
    const filename = exportFilename(name, 'id1');
    expect(filename).toBe(`${'a'.repeat(40)}-id1.hypergeist.json`);
  });

  it('trims a dash left at the cut', () => {
    const name = `${'a'.repeat(39)} ${'b'.repeat(20)}`;
    expect(exportFilename(name, 'id1')).toBe(`${'a'.repeat(39)}-id1.hypergeist.json`);
  });

  it('gives only the id for an empty name', () => {
    expect(exportFilename('', 'only-id')).toBe('only-id.hypergeist.json');
  });

  it('gives only the id for a name of symbols', () => {
    expect(exportFilename('!@#$%^&*()', 'sym')).toBe('sym.hypergeist.json');
  });

  it('stays within the safe pattern and 105 characters before the extension', () => {
    const id = 'z'.repeat(64);
    const filename = exportFilename('x'.repeat(100), id);
    expect(filename).toMatch(/^[a-z0-9_-]+\.hypergeist\.json$/);
    expect(filename.length - '.hypergeist.json'.length).toBe(105);
  });
});

describe('exportStack', () => {
  it('exports a valid stack with a file name from its name and id', () => {
    const result = exportStack(demo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.filename).toBe('thin-slice-to-do-thin-slice-todo.hypergeist.json');
  });

  it('gives text that parses back to a deeply equal stack', () => {
    const result = exportStack(demo);
    if (!result.ok) throw new Error('export should succeed');
    const reparsed = parseStack(result.text);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.value).toEqual(demo);
  });

  it('ends the text with exactly one newline', () => {
    const result = exportStack(demo);
    if (!result.ok) throw new Error('export should succeed');
    expect(result.text.endsWith('}\n')).toBe(true);
    expect(result.text.endsWith('\n\n')).toBe(false);
  });

  it('contains no key, base URL or setting', () => {
    const result = exportStack(demo);
    if (!result.ok) throw new Error('export should succeed');
    expect(result.text).not.toMatch(/apiKey|api_key|baseUrl|base_url|"settings"/i);
  });

  it('uses only the id for a stack with a non-Latin name', () => {
    const result = exportStack({ ...demo, name: '買い物リスト' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.filename).toBe(`${demo.id}.hypergeist.json`);
  });

  it('refuses an invalid stack with one plain message and no file', () => {
    const broken: Stack = { ...demo, startCardId: 'no-such-card' };
    const result = exportStack(broken);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message.length).toBeGreaterThan(0);
    expect(result.message).toContain('no-such-card');
    expect(result.message).toMatch(/\.$/);
    expect('text' in result).toBe(false);
    expect('filename' in result).toBe(false);
  });

  it('does not change the stack it is given', () => {
    const before = structuredClone(demo);
    exportStack(demo);
    exportStack({ ...demo, startCardId: 'no-such-card' });
    expect(demo).toEqual(before);
  });
});
