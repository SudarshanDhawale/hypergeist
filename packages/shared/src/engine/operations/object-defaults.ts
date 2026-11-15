import type { OBJECT_TYPES } from '../../format/index.ts';

/** One of the five Object type names of the format. */
export type ObjectTypeName = (typeof OBJECT_TYPES)[number];

/**
 * Values that `add_object` stores for an optional property the caller left out
 * (Requirement 1.7). Applied in code when the candidate Object is built, never
 * through Zod `.default()`, so the Operation JSON Schemas stay plain.
 *
 * A property that is not listed here is required: `x`, `y`, `width`, `height`
 * (all types), plus `label` (button), `src` (image) and `prompt` (ai-field).
 * `object-defaults.test.ts` checks this table against the format's Zod shapes.
 *
 * The table and its arrays are frozen. Callers copy a row (and its arrays)
 * before they use it in a candidate Object.
 */
export const OBJECT_DEFAULTS = Object.freeze({
  button: Object.freeze({
    name: '',
    onClick: Object.freeze<never[]>([]),
  }),
  field: Object.freeze({
    name: '',
    value: '',
    placeholder: '',
    multiline: false,
    readOnly: false,
  }),
  image: Object.freeze({
    name: '',
    alt: '',
  }),
  list: Object.freeze({
    name: '',
    items: Object.freeze<string[]>([]),
    ordered: false,
  }),
  'ai-field': Object.freeze({
    name: '',
    value: '',
    inputObjectIds: Object.freeze<string[]>([]),
  }),
}) satisfies Readonly<Record<ObjectTypeName, Readonly<Record<string, unknown>>>>;
