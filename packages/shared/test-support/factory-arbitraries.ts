import * as fc from 'fast-check';
import { ENTITY_ID_PATTERN, LIMITS } from '../src/format/index.ts';
import { arbEntityId } from './arbitraries.ts';

/*
 * fast-check generators for the parameters of `createStack`.
 *
 * - `arbCreateStackParams`: valid parameter sets. Card sizes are 64, 4096 or in between, names
 *   have 1 code point, 100 code points or a length in between (ASCII, Latin, astral), and each
 *   optional parameter is present in some sets and omitted in others.
 * - `arbCorruptedCreateStackParams`: a valid set with a non-empty random subset of the six
 *   parameters broken, plus the ordered `{ code, path }` list `createStack` must report.
 *
 * The generators know the format's limits and the requirements (8.9 to 8.14), not the
 * implementation of `createStack`. The key order of the generated objects is shuffled, so
 * the order of the reported errors cannot come from the order of the caller's keys.
 * Everything here is pure: the same seed gives the same values.
 */

/** The six parameters in the order in which `createStack` reports errors (Requirement 8.14). */
export const CREATE_STACK_PARAM_ORDER = [
  'id',
  'name',
  'cardWidth',
  'cardHeight',
  'firstCardId',
  'firstCardName',
] as const;

export type CreateStackParamKey = (typeof CREATE_STACK_PARAM_ORDER)[number];

/** A valid parameter set. Optional parameters are absent (not `undefined`) when omitted. */
export type ValidCreateStackParams = {
  readonly id: string;
  readonly name: string;
  readonly cardWidth?: number;
  readonly cardHeight?: number;
  readonly firstCardId?: string;
  readonly firstCardName?: string;
};

/** The codes a broken parameter can produce (Requirements 8.9 to 8.13). */
export type CreateStackErrorCode =
  'MISSING_PROPERTY' | 'INVALID_VALUE' | 'LIMIT_EXCEEDED' | 'OUT_OF_RANGE' | 'WRONG_TYPE';

export type ExpectedCreateStackError = {
  readonly code: CreateStackErrorCode;
  /** JSON Pointer to the parameter, or the empty string for an omitted parameter. */
  readonly path: string;
};

export type CorruptedCreateStackParams = {
  /** The parameter object to pass to `createStack`. */
  readonly params: Readonly<Record<string, unknown>>;
  /**
   * Exactly one entry per broken parameter: the omitted parameters (path `""`) first, then the
   * invalid ones, each group in the order of `CREATE_STACK_PARAM_ORDER`.
   */
  readonly expectedErrors: readonly ExpectedCreateStackError[];
  /** The broken parameters, in the order of `CREATE_STACK_PARAM_ORDER`. */
  readonly broken: readonly CreateStackParamKey[];
};

/* ---------- text ---------- */

/** One code point per value. No lone surrogates, so the code point count equals the units drawn. */
const arbUnit: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.integer({ min: 0x20, max: 0x7e }).map((cp) => String.fromCodePoint(cp)),
  },
  {
    weight: 1,
    arbitrary: fc.integer({ min: 0xa0, max: 0xd7ff }).map((cp) => String.fromCodePoint(cp)),
  },
  {
    weight: 2,
    arbitrary: fc.integer({ min: 0x10000, max: 0x10ffff }).map((cp) => String.fromCodePoint(cp)),
  },
  { weight: 1, arbitrary: fc.constantFrom('"', '\\', '\n', '\t', '/', '~') },
);

/** Units used to build the texts of exactly the minimum and exactly the maximum length. */
const EDGE_UNITS = ['a', 'é', '😀', '"'] as const;

function arbTextOfLength(min: number, max: number): fc.Arbitrary<string> {
  return fc.array(arbUnit, { minLength: min, maxLength: max }).map((units) => units.join(''));
}

/** A name of 1 to 100 code points: exactly 1, exactly 100, or any length in between. */
function arbValidName(): fc.Arbitrary<string> {
  const { min, max } = LIMITS.stackName;
  return fc.oneof(
    { weight: 6, arbitrary: arbTextOfLength(min, max) },
    { weight: 2, arbitrary: fc.constantFrom(...EDGE_UNITS).map((unit) => unit.repeat(min)) },
    { weight: 2, arbitrary: fc.constantFrom(...EDGE_UNITS).map((unit) => unit.repeat(max)) },
    { weight: 1, arbitrary: arbTextOfLength(max, max) },
  );
}

/** A name of 101 or more code points: exactly 101, or a little more. */
const arbTooLongName: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 1,
    arbitrary: fc.constantFrom(...EDGE_UNITS).map((unit) => unit.repeat(LIMITS.stackName.max + 1)),
  },
  { weight: 2, arbitrary: arbTextOfLength(LIMITS.stackName.max + 1, LIMITS.stackName.max + 150) },
);

/* ---------- sizes ---------- */

const arbValidSize: fc.Arbitrary<number> = fc.oneof(
  { weight: 2, arbitrary: fc.constant(LIMITS.cardSize.min) },
  { weight: 2, arbitrary: fc.constant(LIMITS.cardSize.max) },
  {
    weight: 4,
    arbitrary: fc.integer({ min: LIMITS.cardSize.min + 1, max: LIMITS.cardSize.max - 1 }),
  },
);

/** Numbers that are not integers from 64 through 4096. Each gives OUT_OF_RANGE. */
const arbOutOfRangeSize: fc.Arbitrary<number> = fc.oneof(
  { weight: 1, arbitrary: fc.constantFrom(LIMITS.cardSize.min - 1, LIMITS.cardSize.max + 1) },
  { weight: 1, arbitrary: fc.constantFrom(0, -1, -4096) },
  { weight: 2, arbitrary: fc.integer({ min: -100_000, max: LIMITS.cardSize.min - 1 }) },
  { weight: 2, arbitrary: fc.integer({ min: LIMITS.cardSize.max + 1, max: 1_000_000 }) },
  // Fractions, inside the range and outside it.
  { weight: 2, arbitrary: fc.integer({ min: -100, max: 5000 }).map((n) => n + 0.5) },
  { weight: 1, arbitrary: fc.constantFrom(64.25, 4095.75, 512.1) },
);

/** Values that are not numbers. Each gives WRONG_TYPE. */
const arbNonNumberSize: fc.Arbitrary<unknown> = fc.constantFrom<unknown[]>(
  '512',
  '',
  'wide',
  true,
  false,
  null,
  [],
  {},
);

/* ---------- ids ---------- */

/** Strings that fail the Entity_ID pattern. Each gives INVALID_VALUE. */
const arbBadId: fc.Arbitrary<string> = fc
  .oneof(
    { weight: 1, arbitrary: fc.constantFrom('', ' ', '-a', '_a', 'A', 'Card-1', 'a b', 'a.b') },
    { weight: 1, arbitrary: fc.constantFrom('é', 'a/b', 'a\n', ' a', 'a'.repeat(65)) },
    {
      weight: 2,
      arbitrary: fc
        .tuple(
          fc.constantFrom('A', '-', '_', ' ', '.', '/', 'é', '😀'),
          fc.string({ maxLength: 8 }),
        )
        .map(([head, tail]) => head + tail),
    },
    {
      weight: 1,
      arbitrary: fc
        .string({ unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'), minLength: 65 })
        .map((text) => text.slice(0, 80)),
    },
  )
  // Safety net: a generated string that happens to be a valid id is not a bad id.
  .filter((text) => !ENTITY_ID_PATTERN.test(text));

/* ---------- valid sets ---------- */

type Values = ReadonlyMap<CreateStackParamKey, unknown>;

/** A full permutation of the six keys. */
const arbKeyOrder: fc.Arbitrary<CreateStackParamKey[]> = fc.shuffledSubarray(
  [...CREATE_STACK_PARAM_ORDER],
  { minLength: CREATE_STACK_PARAM_ORDER.length, maxLength: CREATE_STACK_PARAM_ORDER.length },
);

/** Builds the parameter object with its keys in `order`. A key missing from `values` is omitted. */
function assemble(order: readonly CreateStackParamKey[], values: Values): Record<string, unknown> {
  const entries: [string, unknown][] = [];
  for (const key of order) {
    if (values.has(key)) {
      entries.push([key, values.get(key)]);
    }
  }
  return Object.fromEntries(entries);
}

const arbValidValues: fc.Arbitrary<Partial<Record<CreateStackParamKey, string | number>>> =
  fc.record(
    {
      id: arbEntityId,
      name: arbValidName(),
      cardWidth: arbValidSize,
      cardHeight: arbValidSize,
      firstCardId: arbEntityId,
      firstCardName: arbValidName(),
    },
    // Only `id` and `name` are always present. The other four are present in some sets.
    { requiredKeys: ['id', 'name'] },
  );

function toValues(record: Readonly<Record<string, unknown>>): Map<CreateStackParamKey, unknown> {
  const values = new Map<CreateStackParamKey, unknown>();
  for (const key of CREATE_STACK_PARAM_ORDER) {
    if (Object.hasOwn(record, key)) {
      values.set(key, record[key]);
    }
  }
  return values;
}

/**
 * Valid `createStack` parameters: `id` and `name` always, and each of `cardWidth`,
 * `cardHeight`, `firstCardId` and `firstCardName` present or omitted. The keys are in a
 * random order.
 */
export const arbCreateStackParams: fc.Arbitrary<ValidCreateStackParams> = fc
  .tuple(arbValidValues, arbKeyOrder)
  .map(
    ([record, order]) =>
      // The values come from the generators above, so the object has the shape of the type.
      assemble(order, toValues(record)) as ValidCreateStackParams,
  );

/* ---------- corrupted sets ---------- */

/** How one parameter is broken: omitted, or replaced by `value`, with the error it must give. */
type Corruption =
  | { readonly kind: 'omit'; readonly code: 'MISSING_PROPERTY' }
  | { readonly kind: 'replace'; readonly value: unknown; readonly code: CreateStackErrorCode };

function replaceWith(code: CreateStackErrorCode) {
  return (value: unknown): Corruption => ({ kind: 'replace', value, code });
}

const OMIT: Corruption = { kind: 'omit', code: 'MISSING_PROPERTY' };

const arbBadIdCorruption: fc.Arbitrary<Corruption> = arbBadId.map(replaceWith('INVALID_VALUE'));

const arbBadNameCorruption: fc.Arbitrary<Corruption> = fc.oneof(
  { weight: 1, arbitrary: fc.constant(replaceWith('INVALID_VALUE')('')) },
  { weight: 2, arbitrary: arbTooLongName.map(replaceWith('LIMIT_EXCEEDED')) },
);

const arbBadSizeCorruption: fc.Arbitrary<Corruption> = fc.oneof(
  { weight: 3, arbitrary: arbOutOfRangeSize.map(replaceWith('OUT_OF_RANGE')) },
  { weight: 1, arbitrary: arbNonNumberSize.map(replaceWith('WRONG_TYPE')) },
);

/** Every way each parameter can break. `id` and `name` can also be omitted. */
const CORRUPTIONS: Readonly<Record<CreateStackParamKey, fc.Arbitrary<Corruption>>> = {
  id: fc.oneof(
    { weight: 1, arbitrary: fc.constant(OMIT) },
    { weight: 2, arbitrary: arbBadIdCorruption },
  ),
  name: fc.oneof(
    { weight: 1, arbitrary: fc.constant(OMIT) },
    { weight: 2, arbitrary: arbBadNameCorruption },
  ),
  cardWidth: arbBadSizeCorruption,
  cardHeight: arbBadSizeCorruption,
  firstCardId: arbBadIdCorruption,
  firstCardName: arbBadNameCorruption,
};

const arbCorruptions: fc.Arbitrary<Record<CreateStackParamKey, Corruption>> = fc.record({
  id: CORRUPTIONS.id,
  name: CORRUPTIONS.name,
  cardWidth: CORRUPTIONS.cardWidth,
  cardHeight: CORRUPTIONS.cardHeight,
  firstCardId: CORRUPTIONS.firstCardId,
  firstCardName: CORRUPTIONS.firstCardName,
});

/** A non-empty subset of the six keys. Each key is chosen on its own, so any combination occurs. */
const arbBrokenKeys: fc.Arbitrary<CreateStackParamKey[]> = fc.subarray(
  [...CREATE_STACK_PARAM_ORDER],
  { minLength: 1 },
);

/**
 * A valid parameter set with a non-empty random subset of the six parameters broken, and the
 * ordered `{ code, path }` list `createStack` must return (Property 23). The list has one entry
 * per broken parameter, in the order `id`, `name`, `cardWidth`, `cardHeight`, `firstCardId`,
 * `firstCardName`, except that an omitted parameter is reported at `""` and so comes before the
 * invalid ones (see the comment in the generator). Any other broken parameter is reported at
 * `/<parameter>`.
 */
export const arbCorruptedCreateStackParams: fc.Arbitrary<CorruptedCreateStackParams> = fc
  .tuple(arbValidValues, arbKeyOrder, arbBrokenKeys, arbCorruptions)
  .map(([record, order, chosen, corruptions]) => {
    const values = toValues(record);
    const broken = CREATE_STACK_PARAM_ORDER.filter((key) => chosen.includes(key));
    const missing: ExpectedCreateStackError[] = [];
    const invalid: ExpectedCreateStackError[] = [];
    for (const key of broken) {
      const corruption = corruptions[key];
      if (corruption.kind === 'omit') {
        values.delete(key);
        missing.push({ code: corruption.code, path: '' });
      } else {
        values.set(key, corruption.value);
        invalid.push({ code: corruption.code, path: `/${key}` });
      }
    }
    // The format sorts errors in document order, and the parameters root (`""`) comes before
    // any property. Only `id` and `name` can be omitted, so the omitted ones come first (in
    // that order), then the invalid ones in the order of CREATE_STACK_PARAM_ORDER. The two
    // orders differ only when `name` is omitted and an earlier parameter (`id`) is invalid.
    const expectedErrors = [...missing, ...invalid];
    return { params: assemble(order, values), expectedErrors, broken };
  });
