import type { StackObject } from '@hypergeist/shared/format';

/**
 * The accessible name of an Object: its `name` when non-empty, otherwise its `label`
 * (Button), `placeholder` (Field) or `alt` (Image) when non-empty, otherwise its `id`.
 */
export function accessibleName(object: StackObject): string {
  if (object.name !== '') return object.name;
  if (object.type === 'button' && object.label !== '') return object.label;
  if (object.type === 'field' && object.placeholder !== '') return object.placeholder;
  if (object.type === 'image' && object.alt !== '') return object.alt;
  return object.id;
}
