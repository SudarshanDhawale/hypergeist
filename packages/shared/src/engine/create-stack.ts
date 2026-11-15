import { z } from 'zod';
import { CardSchema, StackSchema, checkAgainstSchema, validateStack } from '../format/index.ts';
import type { Stack, ValidationError } from '../format/index.ts';

/** The parameters of `createStack`. Only `id` and `name` are required. */
export type CreateStackParams = {
  readonly id: string;
  readonly name: string;
  /** 64 to 4096, default 512. */
  readonly cardWidth?: number;
  /** 64 to 4096, default 342. */
  readonly cardHeight?: number;
  /** Default `card-1`. */
  readonly firstCardId?: string;
  /** Default `Card 1`. */
  readonly firstCardName?: string;
};

/** A new Stack, or one error per invalid parameter and no Stack. */
export type CreateStackResult =
  | { readonly ok: true; readonly stack: Stack }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

const DEFAULT_CARD_WIDTH = 512;
const DEFAULT_CARD_HEIGHT = 342;
const DEFAULT_CARD_ID = 'card-1';
const DEFAULT_CARD_NAME = 'Card 1';

/** The keys of the parameters in the order their errors are reported (Requirement 8.14). */
const PARAMETER_ORDER = [
  'id',
  'name',
  'cardWidth',
  'cardHeight',
  'firstCardId',
  'firstCardName',
] as const;

/** Strict, built from the format's property schemas so the rules and messages are the format's. */
const CreateStackParamsSchema = z.strictObject({
  id: StackSchema.shape.id,
  name: StackSchema.shape.name,
  cardWidth: StackSchema.shape.cardWidth.optional(),
  cardHeight: StackSchema.shape.cardHeight.optional(),
  firstCardId: CardSchema.shape.id.optional(),
  firstCardName: CardSchema.shape.name.optional(),
});

const RANGE_PATHS = ['/cardWidth', '/cardHeight'] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The format sorts errors in the document order of the candidate, so the parameters are copied
 * into a new object with the known keys first, in the reporting order, and unknown keys last.
 * A value that is not an object, or that cannot be read, is passed on unchanged: the schema
 * check then reports it.
 */
function orderedCandidate(params: unknown): unknown {
  if (!isPlainRecord(params)) return params;
  try {
    const known = PARAMETER_ORDER.filter((key) => Object.hasOwn(params, key));
    const extra = Object.keys(params).filter(
      (key) => !(PARAMETER_ORDER as readonly string[]).includes(key),
    );
    // `fromEntries` defines properties, so an own key such as "__proto__" stays an own key.
    return Object.fromEntries([...known, ...extra].map((key) => [key, params[key]]));
  } catch {
    return params;
  }
}

/**
 * Creates a new valid Stack with one empty Card from a few caller-supplied values. Pure: the
 * caller supplies the id, and there is no clock, randomness or external state, so equal calls
 * give deeply equal results. Every invalid parameter gives one error, in the order `id`, `name`,
 * `cardWidth`, `cardHeight`, `firstCardId`, `firstCardName`. A missing `id` or `name` is
 * reported at the parameters root (path `""`). An unknown parameter gives `UNKNOWN_PROPERTY`.
 */
export function createStack(params: unknown): CreateStackResult {
  const checked = checkAgainstSchema(CreateStackParamsSchema, orderedCandidate(params), {
    rangePaths: RANGE_PATHS,
  });
  if (!checked.ok) return { ok: false, errors: checked.errors };

  const given = checked.value;
  const firstCardId = given.firstCardId ?? DEFAULT_CARD_ID;
  const stack: Stack = {
    formatVersion: 1,
    id: given.id,
    name: given.name,
    cardWidth: given.cardWidth ?? DEFAULT_CARD_WIDTH,
    cardHeight: given.cardHeight ?? DEFAULT_CARD_HEIGHT,
    startCardId: firstCardId,
    cards: [
      {
        id: firstCardId,
        name: given.firstCardName ?? DEFAULT_CARD_NAME,
        objects: [],
        links: [],
        onOpen: [],
      },
    ],
  };

  // Safety net, as for Operations: a new Stack is never returned invalid.
  const validated = validateStack(stack);
  if (!validated.valid) return { ok: false, errors: validated.errors };
  return { ok: true, stack };
}
