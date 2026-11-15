import { describe, expect, it } from 'vitest';
import type {
  AiFieldObject,
  ButtonObject,
  FieldObject,
  ImageObject,
  ListObject,
} from '@hypergeist/shared/format';
import { propertyRows } from './property-rows.ts';

const box = { x: 16, y: 48, width: 380, height: 28 };
const COMMON = ['id', 'type', 'name', 'x', 'y', 'width', 'height'];

const button: ButtonObject = {
  id: 'todo-add',
  type: 'button',
  name: '',
  ...box,
  label: 'Add item',
  onClick: [{ type: 'show_message', text: 'Item added.' }],
};
const field: FieldObject = {
  id: 'todo-new',
  type: 'field',
  name: 'New item',
  ...box,
  value: '',
  placeholder: 'What needs doing?',
  multiline: false,
  readOnly: true,
};
const list: ListObject = {
  id: 'todo-list',
  type: 'list',
  name: 'To-do',
  ...box,
  items: ['a', ''],
  ordered: true,
};

const image = (src: string): ImageObject => ({
  id: 'pic',
  type: 'image',
  name: '',
  ...box,
  src,
  alt: 'A ghost',
});
const aiField: AiFieldObject = {
  id: 'ai-1',
  type: 'ai-field',
  name: 'Summary',
  ...box,
  prompt: 'Summarize this',
  inputObjectIds: ['todo-list', 'todo-new'],
  value: '',
};

const asMap = (rows: readonly { label: string; text: string }[]) =>
  Object.fromEntries(rows.map((r) => [r.label, r.text]));

describe('propertyRows', () => {
  it('lists the common rows first, then the Button properties', () => {
    const rows = propertyRows(button);
    expect(rows.map((r) => r.label)).toEqual([...COMMON, 'label', 'onClick']);
    expect(asMap(rows)).toMatchObject({
      id: 'todo-add',
      type: 'button',
      x: '16',
      y: '48',
      width: '380',
      height: '28',
      label: 'Add item',
      onClick: '[{"type":"show_message","text":"Item added."}]',
    });
  });

  it('lists the Field properties', () => {
    const rows = propertyRows(field);
    expect(rows.map((r) => r.label)).toEqual([
      ...COMMON,
      'value',
      'placeholder',
      'multiline',
      'readOnly',
    ]);
    expect(asMap(rows)).toMatchObject({
      name: 'New item',
      placeholder: 'What needs doing?',
      multiline: 'false',
      readOnly: 'true',
    });
  });

  it('lists the List properties', () => {
    const rows = propertyRows(list);
    expect(rows.map((r) => r.label)).toEqual([...COMMON, 'items', 'ordered']);
    expect(asMap(rows)).toMatchObject({ items: '["a",""]', ordered: 'true' });
  });

  it('lists the Image properties and keeps a short src whole', () => {
    const rows = propertyRows(image('https://example.com/a.png'));
    expect(rows.map((r) => r.label)).toEqual([...COMMON, 'src', 'alt']);
    expect(asMap(rows)).toMatchObject({ src: 'https://example.com/a.png', alt: 'A ghost' });
  });

  it('cuts a 1 MB src to 80 code points followed by an ellipsis', () => {
    const src = `data:image/png;base64,${'A'.repeat(1_000_000)}`;
    const text = asMap(propertyRows(image(src)))['src'] ?? '';
    expect(Array.from(text)).toHaveLength(81);
    expect(text).toBe(`${src.slice(0, 80)}…`);
  });

  it('counts code points, not UTF-16 units, when cutting src', () => {
    const src = `https://example.com/${'😀'.repeat(100)}`;
    const text = asMap(propertyRows(image(src)))['src'] ?? '';
    expect(text).toBe(`${Array.from(src).slice(0, 80).join('')}…`);
  });

  it('does not cut a src of exactly 80 code points', () => {
    const src = `https://example.com/${'a'.repeat(60)}`;
    expect(Array.from(src)).toHaveLength(80);
    expect(asMap(propertyRows(image(src)))['src']).toBe(src);
  });

  it('lists the AI field properties', () => {
    const rows = propertyRows(aiField);
    expect(rows.map((r) => r.label)).toEqual([...COMMON, 'prompt', 'inputObjectIds', 'value']);
    expect(asMap(rows)).toMatchObject({
      prompt: 'Summarize this',
      inputObjectIds: '["todo-list","todo-new"]',
      value: '""',
    });
  });

  it('prints an empty string as two double quotes', () => {
    expect(asMap(propertyRows(button))['name']).toBe('""');
    expect(asMap(propertyRows(field))['value']).toBe('""');
  });

  it('prints strings as-is without added quotes', () => {
    expect(asMap(propertyRows(button))['label']).toBe('Add item');
  });

  it('does not mutate its input', () => {
    const copy = structuredClone(list);
    propertyRows(list);
    expect(list).toEqual(copy);
  });
});
