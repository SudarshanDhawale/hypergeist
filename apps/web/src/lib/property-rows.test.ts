import { describe, expect, it } from 'vitest';
import type { ButtonObject, FieldObject, ListObject } from '@hypergeist/shared/format';
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
