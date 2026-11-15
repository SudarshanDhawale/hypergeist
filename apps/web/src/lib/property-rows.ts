import type { StackObject } from '@hypergeist/shared/format';

export interface PropertyRow {
  readonly label: string;
  readonly text: string;
}

/** Strings print as-is, an empty string prints as `""`, and other values print as JSON. */
function display(value: unknown): string {
  if (typeof value === 'string') return value === '' ? '""' : value;
  return JSON.stringify(value);
}

function row(label: string, value: unknown): PropertyRow {
  return { label, text: display(value) };
}

const SRC_DISPLAY_CODE_POINTS = 80;

/** Cuts `text` to `max` code points and appends "…" when something was cut. Never copies the whole input. */
function cutToCodePoints(text: string, max: number): string {
  let end = 0;
  for (let count = 0; count < max; count += 1) {
    if (end >= text.length) return text;
    end += (text.codePointAt(end) ?? 0) > 0xffff ? 2 : 1;
  }
  return end >= text.length ? text : `${text.slice(0, end)}…`;
}

/**
 * Rows for the Property_Readout: `id`, `type`, `name`, `x`, `y`, `width`, `height`,
 * then the type-specific properties in schema order.
 */
export function propertyRows(object: StackObject): readonly PropertyRow[] {
  const common = [
    row('id', object.id),
    row('type', object.type),
    row('name', object.name),
    row('x', object.x),
    row('y', object.y),
    row('width', object.width),
    row('height', object.height),
  ];
  switch (object.type) {
    case 'button':
      return [...common, row('label', object.label), row('onClick', object.onClick)];
    case 'field':
      return [
        ...common,
        row('value', object.value),
        row('placeholder', object.placeholder),
        row('multiline', object.multiline),
        row('readOnly', object.readOnly),
      ];
    case 'image':
      return [
        ...common,
        row('src', cutToCodePoints(object.src, SRC_DISPLAY_CODE_POINTS)),
        row('alt', object.alt),
      ];
    case 'list':
      return [...common, row('items', object.items), row('ordered', object.ordered)];
    case 'ai-field':
      return [
        ...common,
        row('prompt', object.prompt),
        row('inputObjectIds', object.inputObjectIds),
        row('value', object.value),
      ];
  }
}
