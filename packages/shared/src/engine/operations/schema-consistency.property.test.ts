import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { arbEntityId, arbHandlerFor, arbStack } from '../../../test-support/arbitraries.ts';
import { deepCopy, deepFreeze } from '../../../test-support/freeze.ts';
import { createSchemaValidator } from '../../../test-support/schema-validator.ts';
import type { CompiledSchema, SchemaCheck } from '../../../test-support/schema-validator.ts';
import { assertProperty } from '../../../test-support/seed.ts';
import { OBJECT_TYPES, validateStack } from '../../format/index.ts';
import type { Stack, StackObject } from '../../format/index.ts';
import { OPERATIONS, OPERATION_NAMES, applyOperation, operationJsonSchema } from './index.ts';
import type { OperationName } from './index.ts';

/*
 * Parameter generators. They live in this file on purpose: the shared operation arbitraries
 * (task 9.14) are written in parallel and this test does not depend on them.
 */

type ObjectType = StackObject['type'];

type Ids = {
  readonly cards: readonly string[];
  readonly objects: readonly string[];
  readonly typeOf: ReadonlyMap<string, ObjectType>;
  readonly everything: readonly string[];
};

function collectIds(stack: Stack): Ids {
  const cards: string[] = [];
  const objects: string[] = [];
  const links: string[] = [];
  const typeOf = new Map<string, ObjectType>();
  for (const card of stack.cards) {
    cards.push(card.id);
    for (const object of card.objects) {
      objects.push(object.id);
      typeOf.set(object.id, object.type);
    }
    for (const link of card.links) links.push(link.id);
  }
  return { cards, objects, typeOf, everything: [...cards, ...objects, ...links] };
}

/** An existing id of the given pool most of the time, an arbitrary id otherwise. */
function arbIdIn(pool: readonly string[]): fc.Arbitrary<string> {
  if (pool.length === 0) return arbEntityId;
  return fc.oneof(
    { weight: 4, arbitrary: fc.constantFrom(...pool) },
    { weight: 1, arbitrary: arbEntityId },
  );
}

/** Text of `min` to `max` code points: short ASCII, short binary, or at the bounds (also astral). */
function arbText(min: number, max: number): fc.Arbitrary<string> {
  const short = Math.min(max, 12);
  return fc.oneof(
    { weight: 4, arbitrary: fc.string({ minLength: min, maxLength: short }) },
    { weight: 1, arbitrary: fc.string({ unit: 'binary', minLength: min, maxLength: short }) },
    {
      weight: 1,
      arbitrary: fc
        .tuple(fc.constantFrom('a', '\u{1F600}'), fc.constantFrom(min, max, max + 1))
        .map(([unit, count]) => unit.repeat(count)),
    },
  );
}

const arbCoordinate = fc.oneof(
  { weight: 6, arbitrary: fc.integer({ min: 0, max: 300 }) },
  { weight: 1, arbitrary: fc.integer({ min: 0, max: 4096 }) },
);
const arbSize = fc.oneof(
  { weight: 6, arbitrary: fc.integer({ min: 8, max: 300 }) },
  { weight: 1, arbitrary: fc.integer({ min: 8, max: 4096 }) },
);
const arbImageSource = fc.constantFrom(
  'https://example.com/a.png',
  'https://example.com',
  'data:image/png;base64,AAAA',
  'data:image/gif;base64,R0lGODlh',
  'http://example.com/a.png',
);

/** Properties that belong to every Object type, and to each type. */
const TYPE_KEYS: Readonly<Record<ObjectType, readonly string[]>> = {
  button: ['label', 'onClick'],
  field: ['value', 'placeholder', 'multiline', 'readOnly'],
  list: ['items', 'ordered'],
  image: ['src', 'alt'],
  'ai-field': ['prompt', 'inputObjectIds', 'value'],
};
const REQUIRED_KEYS: Readonly<Record<ObjectType, readonly string[]>> = {
  button: ['label'],
  field: [],
  list: [],
  image: ['src'],
  'ai-field': ['prompt'],
};

/** Every Object property that is not one of the shared geometry or id properties. */
function arbObjectProps(stack: Stack): fc.Arbitrary<Record<string, unknown>> {
  const { objects } = collectIds(stack);
  return fc.record(
    {
      name: arbText(0, 100),
      label: arbText(1, 100),
      onClick: arbHandlerFor(stack, 'all'),
      value: arbText(0, 10_000),
      placeholder: arbText(0, 200),
      multiline: fc.boolean(),
      readOnly: fc.boolean(),
      items: fc.array(arbText(0, 500), { maxLength: 5 }),
      ordered: fc.boolean(),
      src: arbImageSource,
      alt: arbText(0, 200),
      prompt: arbText(1, 2000),
      inputObjectIds: fc.uniqueArray(arbIdIn(objects), { maxLength: 4 }),
    },
    { requiredKeys: ['label', 'src', 'prompt'] },
  );
}

/**
 * mode 0 to 6: only the properties of the type, required ones present.
 * mode 7: the same without the required ones. mode 8 and 9: every property, whatever the type.
 */
function selectProps(
  type: ObjectType,
  props: Record<string, unknown>,
  mode: number,
): Record<string, unknown> {
  if (mode >= 8) return props;
  const allowed = new Set<string>(['name', ...TYPE_KEYS[type]]);
  const required = REQUIRED_KEYS[type];
  return Object.fromEntries(
    Object.entries(props).filter(
      ([key]) => allowed.has(key) && (mode !== 7 || !required.includes(key)),
    ),
  );
}

function compact(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));
}

const arbMode = fc.integer({ min: 0, max: 9 });

function arbAddObjectParams(
  stack: Stack,
  modes: fc.Arbitrary<number>,
): fc.Arbitrary<Record<string, unknown>> {
  const { cards } = collectIds(stack);
  return fc
    .record({
      cardId: arbIdIn(cards),
      type: fc.constantFrom(...OBJECT_TYPES),
      x: arbCoordinate,
      y: arbCoordinate,
      width: arbSize,
      height: arbSize,
      id: fc.option(arbEntityId, { nil: undefined }),
      index: fc.option(fc.integer({ min: 0, max: 4 }), { nil: undefined }),
      props: arbObjectProps(stack),
      mode: modes,
    })
    .map(({ props, mode, type, ...rest }) =>
      compact({ ...rest, type, ...selectProps(type, props, mode) }),
    );
}

function arbUpdateObjectParams(stack: Stack): fc.Arbitrary<Record<string, unknown>> {
  const ids = collectIds(stack);
  return fc
    .record({
      objectId: arbIdIn(ids.objects),
      props: arbObjectProps(stack),
      geometry: fc.record(
        { x: arbCoordinate, y: arbCoordinate, width: arbSize, height: arbSize },
        { requiredKeys: [] },
      ),
      fixed: fc.record(
        { id: arbEntityId, type: fc.constantFrom(...OBJECT_TYPES) },
        { requiredKeys: [] },
      ),
      mode: arbMode,
    })
    .chain(({ objectId, props, geometry, fixed, mode }) => {
      const type = ids.typeOf.get(objectId);
      const everything: Record<string, unknown> = { ...props, ...geometry };
      const available = new Set(
        type === undefined
          ? Object.keys(everything)
          : ['name', 'x', 'y', 'width', 'height', ...TYPE_KEYS[type]],
      );
      const pool: Record<string, unknown> = Object.fromEntries(
        Object.entries(everything).filter(([key]) => mode >= 8 || available.has(key)),
      );
      // `id` and `type` can never change, so they only appear in some of the cases.
      const withFixed: Record<string, unknown> = mode === 9 ? { ...pool, ...fixed } : pool;
      return fc.subarray(Object.keys(withFixed)).map((keys) => ({
        objectId,
        changes: Object.fromEntries(keys.map((key) => [key, withFixed[key]])),
      }));
    });
}

function arbParamsFor(stack: Stack, name: OperationName): fc.Arbitrary<unknown> {
  const ids = collectIds(stack);
  switch (name) {
    case 'create_card':
      return fc
        .record({
          name: arbText(1, 100),
          id: fc.option(arbEntityId, { nil: undefined }),
          index: fc.option(fc.integer({ min: 0, max: 5 }), { nil: undefined }),
        })
        .map(compact);
    case 'delete_card':
      return fc.record({ cardId: arbIdIn(ids.cards) });
    case 'add_object':
      return arbAddObjectParams(stack, arbMode);
    case 'update_object':
      return arbUpdateObjectParams(stack);
    case 'remove_object':
      return fc.record({ objectId: arbIdIn(ids.objects) });
    case 'link_cards':
      return fc
        .record({
          fromCardId: arbIdIn(ids.cards),
          toCardId: arbIdIn(ids.cards),
          label: arbText(1, 100),
          id: fc.option(arbEntityId, { nil: undefined }),
        })
        .map(compact);
    case 'set_action':
      return fc.record({
        ownerId: arbIdIn(ids.everything),
        handler: arbHandlerFor(stack, 'all'),
      });
  }
}

type Call = { readonly name: OperationName; readonly params: unknown };

function arbValidishCall(stack: Stack): fc.Arbitrary<Call> {
  return fc
    .constantFrom(...OPERATION_NAMES)
    .chain((name) => arbParamsFor(stack, name).map((params): Call => ({ name, params })));
}

/* ---------- structural mutations ---------- */

type Path = readonly (string | number)[];
type Container = Record<string, unknown> | unknown[];

type Mutation = {
  readonly kind: 'delete' | 'replace' | 'swap-type' | 'add-unknown' | 'out-of-range' | 'root';
  readonly pick: number;
  readonly replacement: unknown;
  readonly key: string;
};

const arbMutation: fc.Arbitrary<Mutation> = fc.record({
  kind: fc.constantFrom(
    'delete',
    'replace',
    'swap-type',
    'add-unknown',
    'out-of-range',
    'root',
  ) as fc.Arbitrary<Mutation['kind']>,
  pick: fc.nat(),
  replacement: fc.jsonValue(),
  key: fc.string({ minLength: 1, maxLength: 8 }),
});

function isContainer(value: unknown): value is Container {
  return typeof value === 'object' && value !== null;
}

function childKeys(container: Container): (string | number)[] {
  return Array.isArray(container) ? container.map((_, index) => index) : Object.keys(container);
}

function getChild(container: Container, key: string | number): unknown {
  return Array.isArray(container)
    ? container[key as number]
    : Object.getOwnPropertyDescriptor(container, key)?.value;
}

function setChild(container: Container, key: string | number, value: unknown): void {
  if (Array.isArray(container)) {
    container[key as number] = value;
  } else {
    // defineProperty keeps an own "__proto__" key as data.
    Object.defineProperty(container, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
}

function getAt(root: unknown, path: Path): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (!isContainer(current)) return undefined;
    current = getChild(current, key);
  }
  return current;
}

function collectPaths(value: unknown, prefix: Path, paths: Path[], containers: Path[]): void {
  if (!isContainer(value)) return;
  containers.push(prefix);
  for (const key of childKeys(value)) {
    const path = [...prefix, key];
    paths.push(path);
    collectPaths(getChild(value, key), path, paths, containers);
  }
}

function otherJsonType(value: unknown): unknown {
  if (typeof value === 'string') return 42;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return 'true';
  if (value === null) return 0;
  return Array.isArray(value) ? {} : [];
}

function outsideRange(value: unknown): unknown {
  if (typeof value === 'number') return value < 0 ? 1e9 : Number.isInteger(value) ? -1 : 1.5;
  if (typeof value === 'string') return value === '' ? 'x'.repeat(5001) : '';
  if (Array.isArray(value)) return [...value, ...Array.from({ length: 600 }, () => 'x')];
  return value;
}

const ROOT_REPLACEMENTS: readonly (() => unknown)[] = [
  () => null,
  () => [],
  () => 'create_card',
  () => 0,
  () => true,
  () => ({}),
];

/** Applies one mutation to a copy of `params`. */
function mutate(params: unknown, mutation: Mutation): unknown {
  if (mutation.kind === 'root') {
    const make = ROOT_REPLACEMENTS[mutation.pick % ROOT_REPLACEMENTS.length];
    return make === undefined ? null : make();
  }
  const root = deepCopy(params);
  const paths: Path[] = [];
  const containers: Path[] = [];
  collectPaths(root, [], paths, containers);

  if (mutation.kind === 'add-unknown') {
    const target = containers[mutation.pick % Math.max(containers.length, 1)];
    const container = target === undefined ? undefined : getAt(root, target);
    if (!isContainer(container)) return root;
    if (Array.isArray(container)) container.push({ [mutation.key]: 1 });
    else setChild(container, `zz_${mutation.key}`, 1);
    return root;
  }

  const path = paths[mutation.pick % Math.max(paths.length, 1)];
  const key = path?.at(-1);
  const parent = path === undefined ? undefined : getAt(root, path.slice(0, -1));
  if (path === undefined || key === undefined || !isContainer(parent)) return root;
  const current = getChild(parent, key);
  switch (mutation.kind) {
    case 'delete':
      if (Array.isArray(parent)) parent.splice(key as number, 1);
      else Reflect.deleteProperty(parent, key);
      break;
    case 'replace':
      setChild(parent, key, mutation.replacement);
      break;
    case 'swap-type':
      setChild(parent, key, otherJsonType(current));
      break;
    case 'out-of-range':
      setChild(parent, key, outsideRange(current));
      break;
  }
  return root;
}

/* ---------- the calls under test ---------- */

type StackCall = Call & { readonly stack: Stack };

/** Parameters that mostly conform, mutated variants of them, and arbitrary JSON. */
const arbStackCall: fc.Arbitrary<StackCall> = arbStack.chain((stack) =>
  fc
    .oneof(
      { weight: 3, arbitrary: arbValidishCall(stack) },
      {
        weight: 4,
        arbitrary: arbValidishCall(stack).chain((call) =>
          arbMutation.map((mutation): Call => ({
            name: call.name,
            params: mutate(call.params, mutation),
          })),
        ),
      },
      {
        weight: 1,
        arbitrary: fc
          .tuple(fc.constantFrom(...OPERATION_NAMES), fc.jsonValue())
          .map(([name, params]): Call => ({ name, params })),
      },
    )
    .map((call): StackCall => ({ ...call, stack })),
);

const validator = createSchemaValidator();
const ajvChecks = new Map<OperationName, CompiledSchema>(
  OPERATION_NAMES.map((name) => [name, validator.compile(operationJsonSchema(name))]),
);

function ajvReport(name: OperationName, params: unknown): SchemaCheck {
  const check = ajvChecks.get(name);
  if (check === undefined) throw new Error(`no compiled schema for ${name}`);
  return check(params);
}

function ajvAccepts(name: OperationName, params: unknown): boolean {
  return ajvReport(name, params).valid;
}

function zodAccepts(name: OperationName, params: unknown): boolean {
  const info = OPERATIONS.find((operation) => operation.name === name);
  if (info === undefined) throw new Error(`no operation info for ${name}`);
  return info.schema.safeParse(params).success;
}

/** True when an Action object anywhere in `value` breaks an exactly-one-of rule of the format. */
function hasExactlyOneOfViolation(value: unknown): boolean {
  if (!isContainer(value)) return false;
  if (!Array.isArray(value)) {
    const has = (key: string): boolean => Object.hasOwn(value, key);
    const type = Object.getOwnPropertyDescriptor(value, 'type')?.value;
    if (type === 'set_value' && has('value') === has('fromObjectId')) return true;
    if (type === 'schedule_notification' && has('at') === has('atFromObjectId')) return true;
  }
  return childKeys(value).some((key) => hasExactlyOneOfViolation(getChild(value, key)));
}

describe('operation schemas and applyOperation', () => {
  // Feature: stack-engine, Property 15: Schema violations are rejected and conforming parameters never throw
  // **Validates: Requirements 3.12, 9.3, 9.5, 9.6**
  it('rejects every ajv violation, never throws, and leaves the Stack unchanged', () => {
    const seen = { ajvValid: 0, ajvInvalid: 0, accepted: 0, rejected: 0 };
    assertProperty(
      fc.property(arbStackCall, ({ stack, name, params }) => {
        const original = deepCopy(stack);
        const frozenStack = deepFreeze(deepCopy(stack));
        const frozenParams = deepFreeze(deepCopy(params));
        const conforms = ajvAccepts(name, frozenParams);

        // A throw here fails the property and fast-check reports the counterexample.
        const result = applyOperation(frozenStack, name, frozenParams);

        expect(frozenStack).toEqual(original);
        if (result.ok) {
          expect(validateStack(result.stack).valid).toBe(true);
          seen.accepted += 1;
        } else {
          expect(result.errors.length).toBeGreaterThanOrEqual(1);
          expect('stack' in result).toBe(false);
          seen.rejected += 1;
        }
        if (conforms) {
          seen.ajvValid += 1;
        } else {
          seen.ajvInvalid += 1;
          expect(result.ok).toBe(false);
        }
      }),
    );
    // The generators must reach every branch, otherwise the property proves nothing.
    expect(seen.ajvValid).toBeGreaterThan(0);
    expect(seen.ajvInvalid).toBeGreaterThan(0);
    expect(seen.accepted).toBeGreaterThan(0);
    expect(seen.rejected).toBeGreaterThan(0);
  });

  // Feature: stack-engine, Property 15: Schema violations are rejected and conforming parameters never throw
  // **Validates: Requirements 9.5, 9.6**
  it('agrees with the Zod schema about structural validity', () => {
    const seen = { agreedValid: 0, agreedInvalid: 0 };
    assertProperty(
      fc.property(arbStackCall, ({ name, params }) => {
        const report = ajvReport(name, params);
        const ajv = report.valid;
        const zod = zodAccepts(name, params);
        const detail = report.valid ? '' : report.errors.join('; ');
        const context = `${name}: ajv ${ajv}, zod ${zod}. ajv errors: ${detail}`;

        // The JSON Schema is never looser than the Zod schema.
        if (ajv) expect(zod, context).toBe(true);
        // It is stricter in one place only: the exactly-one-of rules that Zod keeps as `oneOf`
        // metadata (`set_value`: value or fromObjectId; `schedule_notification`: at or
        // atFromObjectId). The engine rejects those through the format's semantic pass.
        if (zod && !ajv) expect(hasExactlyOneOfViolation(params), context).toBe(true);
        if (ajv) seen.agreedValid += 1;
        else seen.agreedInvalid += 1;
      }),
    );
    expect(seen.agreedValid).toBeGreaterThan(0);
    expect(seen.agreedInvalid).toBeGreaterThan(0);
  });

  // Feature: stack-engine, Property 15: Schema violations are rejected and conforming parameters never throw
  // **Validates: Requirements 3.12**
  it('reports MISSING_PROPERTY for an omitted required add_object property', () => {
    assertProperty(
      fc.property(
        arbStack.chain((stack) =>
          fc.tuple(
            fc.constant(stack),
            arbAddObjectParams(stack, fc.integer({ min: 0, max: 6 })),
            fc.nat(),
          ),
        ),
        ([stack, params, pick]) => {
          // A parameter that breaks the schema (for example a 101-character name) is reported
          // alone, before the per-type checks run, so this property needs conforming parameters.
          // An unknown Card is also reported alone, so the Card must exist.
          fc.pre(ajvAccepts('add_object', params));
          fc.pre(stack.cards.some((card) => card.id === params['cardId']));
          const type = params['type'] as ObjectType;
          const required = ['cardId', 'type', 'x', 'y', 'width', 'height', ...REQUIRED_KEYS[type]];
          const omitted = required[pick % required.length] ?? 'cardId';
          const rest = Object.fromEntries(
            Object.entries(params).filter(([key]) => key !== omitted),
          );
          const result = applyOperation(deepFreeze(deepCopy(stack)), 'add_object', rest);

          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.errors.map((error) => error.code)).toContain('MISSING_PROPERTY');
          }
        },
      ),
    );
  });

  // Feature: stack-engine, Property 15: Schema violations are rejected and conforming parameters never throw
  // **Validates: Requirements 3.12**
  it('reports INVALID_VALUE for an invalid value of a present add_object property', () => {
    const invalidValues: Readonly<Record<string, unknown>> = {
      type: 'bogus',
      id: 'Bad Id!',
      x: -1,
      y: -1,
      width: 0,
      height: 0,
      label: '',
      src: 'ftp://nowhere',
      prompt: '',
    };
    assertProperty(
      fc.property(
        arbStack.chain((stack) =>
          fc.tuple(
            fc.constant(stack),
            arbAddObjectParams(stack, fc.integer({ min: 0, max: 6 })),
            fc.nat(),
          ),
        ),
        ([stack, params, pick]) => {
          const present = Object.keys(invalidValues).filter((key) => key in params);
          const target = present[pick % present.length] ?? 'x';
          const result = applyOperation(deepFreeze(deepCopy(stack)), 'add_object', {
            ...params,
            [target]: invalidValues[target],
          });

          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.errors.map((error) => error.code)).toContain('INVALID_VALUE');
          }
        },
      ),
    );
  });
});
