import { describe, expect, it } from 'vitest';
import type {
  AiFieldObject,
  ButtonObject,
  FieldObject,
  ImageObject,
  ListObject,
} from '@hypergeist/shared/format';
import { accessibleName } from './accessible-name.ts';

const box = { x: 0, y: 0, width: 100, height: 30 };
const button = (name: string, label: string): ButtonObject => ({
  id: 'b1',
  type: 'button',
  name,
  ...box,
  label,
  onClick: [],
});
const field = (name: string, placeholder: string): FieldObject => ({
  id: 'f1',
  type: 'field',
  name,
  ...box,
  value: '',
  placeholder,
  multiline: false,
  readOnly: false,
});
const list = (name: string): ListObject => ({
  id: 'l1',
  type: 'list',
  name,
  ...box,
  items: [],
  ordered: false,
});

const image = (name: string, alt: string): ImageObject => ({
  id: 'i1',
  type: 'image',
  name,
  ...box,
  src: 'https://example.com/a.png',
  alt,
});
const aiField = (name: string): AiFieldObject => ({
  id: 'a1',
  type: 'ai-field',
  name,
  ...box,
  prompt: 'p',
  inputObjectIds: [],
  value: '',
});

describe('accessibleName', () => {
  it('uses the Image name first, then alt, then the id', () => {
    expect(accessibleName(image('Logo', 'A ghost'))).toBe('Logo');
    expect(accessibleName(image('', 'A ghost'))).toBe('A ghost');
    expect(accessibleName(image('', ''))).toBe('i1');
  });

  it('uses the AI field name, then the id', () => {
    expect(accessibleName(aiField('Summary'))).toBe('Summary');
    expect(accessibleName(aiField(''))).toBe('a1');
  });

  it('prefers a non-empty name for every type', () => {
    expect(accessibleName(button('Add', 'Add item'))).toBe('Add');
    expect(accessibleName(field('New', 'Type here'))).toBe('New');
    expect(accessibleName(list('Tasks'))).toBe('Tasks');
  });

  it('falls back to the Button label', () => {
    expect(accessibleName(button('', 'Add item'))).toBe('Add item');
  });

  it('falls back to the Field placeholder', () => {
    expect(accessibleName(field('', 'Type here'))).toBe('Type here');
  });

  it('falls back to the id when name and label or placeholder are empty', () => {
    expect(accessibleName(field('', ''))).toBe('f1');
    expect(accessibleName(list(''))).toBe('l1');
  });
});
