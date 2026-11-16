import 'fake-indexeddb/auto';

import { validateStack } from '@hypergeist/shared/format';
import type { Stack } from '@hypergeist/shared/format';
import { createStack } from '@hypergeist/shared/engine';
import { IDBFactory } from 'fake-indexeddb';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  arbCandidate,
  arbMutationFor,
  arbStack,
} from '../../../../packages/shared/test-support/arbitraries.ts';
import {
  SEED_VARIABLE,
  getTestSeed,
  propertyParams,
} from '../../../../packages/shared/test-support/seed.ts';
import { openIdbRepository } from './idb-repository.ts';
import type { IdbRepository } from './idb-repository.ts';
import { createMemoryRepository } from './memory-repository.ts';
import type { MemoryRepository } from './memory-repository.ts';
import type { Repository, Result, SeedStack, TrashSummary } from './types.ts';

/*
 * `assertProperty` in the shared test support is synchronous (it calls `fc.assert` without
 * awaiting), and every Repository method is asynchronous. So this file has a thin async twin
 * that uses the same seed and parameter helpers (`propertyParams`, `getTestSeed`) and prints
 * the same seed on failure.
 */
async function assertAsyncProperty<T>(
  property: fc.IAsyncProperty<T>,
  overrides?: Partial<fc.Parameters<T>>,
): Promise<void> {
  try {
    await fc.assert(property, propertyParams<T>(overrides));
  } catch (error: unknown) {
    const seed = getTestSeed();
    console.error(`Property failed with ${SEED_VARIABLE}=${seed}`);
    console.error(
      `Replay with: ${SEED_VARIABLE}=${seed} pnpm exec vitest run apps/web/src/persistence/repository.property.test.ts`,
    );
    throw error;
  }
}

/** Explicit test timeout. A parallel full-suite run is slower than a single file run. */
const TEST_TIMEOUT_MS = 60_000;
const TRASH_CAP = 50;

/** Module counter used as the caller-supplied clock. Strictly increasing, never `Date.now`. */
let clock = 1_000;
function tick(): number {
  clock += 1;
  return clock;
}

type Pair = {
  readonly memory: MemoryRepository;
  readonly idb: IdbRepository;
  readonly close: () => Promise<void>;
};

/** A memory repository and an IndexedDB repository on its own factory, so runs cannot see each other. */
async function openPair(): Promise<Pair> {
  const memory = createMemoryRepository();
  const idb = await openIdbRepository({ name: 'property', indexedDB: new IDBFactory() });
  return {
    memory,
    idb,
    close: async () => {
      await memory.close();
      await idb.close();
    },
  };
}

function valueOf<T>(result: Result<T>, what: string): T {
  if (!result.ok) {
    throw new Error(`${what} failed: ${result.errors.map((error) => error.code).join(', ')}`);
  }
  return result.value;
}

async function quarantineOf(repository: MemoryRepository | IdbRepository): Promise<unknown[]> {
  const entries = await Promise.resolve(repository.testing.quarantine());
  return entries.map((entry) => entry.record);
}

describe('repositories (property)', () => {
  it(
    'Feature: local-persistence, Property 2: Save then load is lossless',
    async () => {
      // **Validates: Requirements 1.2, 1.3**
      await assertAsyncProperty(
        fc.asyncProperty(arbStack, async (stack) => {
          const pair = await openPair();
          try {
            for (const [label, repository] of [
              ['memory', pair.memory],
              ['idb', pair.idb],
            ] as const) {
              const saved = valueOf(await repository.save(stack, tick()), `${label} save`);
              expect(saved.id, label).toBe(stack.id);
              expect(saved.name, label).toBe(stack.name);

              const loaded = valueOf(await repository.load(stack.id), `${label} load`);
              expect(loaded, label).toEqual(stack);

              const listed = valueOf(await repository.list(tick()), `${label} list`);
              expect(listed.problems, label).toEqual([]);
              expect(
                listed.stacks.filter((summary) => summary.id === stack.id),
                label,
              ).toEqual([saved]);
            }
          } finally {
            await pair.close();
          }
        }),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'Feature: local-persistence, Property 3: A rejected save changes nothing',
    async () => {
      // **Validates: Requirements 1.2**
      const arbRejected = arbStack.chain((stored) =>
        fc.record({
          stored: fc.constant(stored),
          // Arbitrary candidates, plus invalid mutations of the stored stack itself (same id).
          candidate: fc.oneof(
            arbCandidate,
            arbMutationFor(stored).map((m) => m.mutated),
          ),
        }),
      );
      await assertAsyncProperty(
        fc.asyncProperty(
          arbRejected.filter((c) => !validateStack(c.candidate).valid),
          async ({ stored, candidate }) => {
            const pair = await openPair();
            try {
              for (const [label, repository] of [
                ['memory', pair.memory],
                ['idb', pair.idb],
              ] as const) {
                valueOf(await repository.save(stored, tick()), `${label} first save`);
                const listBefore = valueOf(await repository.list(tick()), `${label} list`);
                const trashBefore = valueOf(await repository.listTrash(), `${label} trash`);
                const quarantineBefore = await quarantineOf(repository);

                // The one allowed cast: simulates untrusted input reaching `save`.
                const rejected = await repository.save(candidate as unknown as Stack, tick());
                expect(rejected.ok, label).toBe(false);
                if (rejected.ok) return;
                expect(rejected.errors[0]?.code, label).toBe('INVALID_STACK');
                expect(rejected.errors[0]?.validationErrors?.length ?? 0, label).toBeGreaterThan(0);

                expect(valueOf(await repository.load(stored.id), `${label} load`), label).toEqual(
                  stored,
                );
                expect(valueOf(await repository.list(tick()), `${label} list`), label).toEqual({
                  stacks: listBefore.stacks,
                  problems: [],
                });
                expect(valueOf(await repository.listTrash(), `${label} trash`), label).toEqual(
                  trashBefore,
                );
                expect(await quarantineOf(repository), label).toEqual(quarantineBefore);
              }
            } finally {
              await pair.close();
            }
          },
        ),
      );
    },
    TEST_TIMEOUT_MS,
  );
});

/* ---------- Property 4: model-based sequence ---------- */

const POOL_IDS = ['a', 'b', 'c', 'd'] as const;
/** Ids offered as `newId` when restoring: the pool, plus one that fails the id pattern. */
const NEW_ID_CHOICES = [...POOL_IDS, 'Bad Id'] as const;
/** A trash key no repository has. */
const MISSING_TRASH_KEY = 1_000_000;

const COMMAND_KINDS = [
  'save',
  'create',
  'moveToTrash',
  'restoreFromTrash',
  'restoreDemo',
  'deleteForever',
  'emptyTrash',
] as const;
type CommandKind = (typeof COMMAND_KINDS)[number];

/**
 * A command as generated. It cannot name real ids or trash keys, because those depend on the
 * state after the earlier commands. `resolveCommand` turns it into a call against that state.
 */
type CommandTemplate = {
  readonly kind: CommandKind;
  /** In [0, 1). Chooses between an existing id and a pool id, and which one. */
  readonly idPick: number;
  readonly poolIndex: number;
  readonly nameIndex: number;
  readonly newIdIndex: number;
  readonly useNewId: boolean;
  /** In [0, 1). Chooses a trash record. */
  readonly trashPick: number;
  /** Which pool ids are in the seed list of `restoreDemo`. */
  readonly seedMask: readonly boolean[];
};

function arbFraction(): fc.Arbitrary<number> {
  return fc.integer({ min: 0, max: 999 }).map((n) => n / 1000);
}

function arbTemplate(
  kinds: fc.Arbitrary<CommandKind>,
  allSeeds: boolean,
): fc.Arbitrary<CommandTemplate> {
  return fc.record({
    kind: kinds,
    idPick: arbFraction(),
    poolIndex: fc.integer({ min: 0, max: POOL_IDS.length - 1 }),
    nameIndex: fc.integer({ min: 0, max: 3 }),
    newIdIndex: fc.integer({ min: 0, max: NEW_ID_CHOICES.length - 1 }),
    useNewId: fc.boolean(),
    trashPick: arbFraction(),
    seedMask: allSeeds
      ? fc.constant(POOL_IDS.map(() => true))
      : fc.array(fc.boolean(), { minLength: POOL_IDS.length, maxLength: POOL_IDS.length }),
  });
}

/**
 * Two kinds of sequences: general ones (0 to 25 commands) and ones made of `restoreDemo` with
 * four seeds plus a few saves, long enough to push more than 50 records into the trash.
 */
const arbSequence: fc.Arbitrary<readonly CommandTemplate[]> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.array(arbTemplate(fc.constantFrom(...COMMAND_KINDS), false), { maxLength: 25 }),
  },
  {
    weight: 1,
    arbitrary: fc.array(
      arbTemplate(
        fc.constantFrom<CommandKind>('restoreDemo', 'restoreDemo', 'restoreDemo', 'save'),
        true,
      ),
      { minLength: 16, maxLength: 25 },
    ),
  },
);

function makeStack(id: string, nameIndex: number, prefix: string): Stack {
  const created = createStack({ id, name: `${prefix} ${id} ${nameIndex}` });
  if (!created.ok) {
    throw new Error(`The test stack "${id}" could not be created.`);
  }
  return created.stack;
}

/** What the generated command means in the current state. Independent of the repository. */
type Resolved =
  | { readonly kind: 'save' | 'create'; readonly stack: Stack }
  | { readonly kind: 'moveToTrash'; readonly id: string }
  | {
      readonly kind: 'restoreFromTrash';
      readonly slot: number | undefined;
      readonly newId: string | undefined;
    }
  | { readonly kind: 'restoreDemo'; readonly seeds: readonly SeedStack[] }
  | { readonly kind: 'deleteForever'; readonly slot: number | undefined }
  | { readonly kind: 'emptyTrash' };

/** Position in the newest-first trash list, or `undefined` for a key no repository has. */
function pickSlot(pick: number, trashLength: number): number | undefined {
  if (trashLength === 0 || pick < 0.1) return undefined;
  return Math.min(trashLength - 1, Math.floor(pick * trashLength));
}

/** The state a command is resolved against: ids on the shelf and the length of the trash. */
type Model = { readonly ids: readonly string[]; readonly trashLength: number };

function resolveCommand(model: Model, template: CommandTemplate): Resolved {
  const fromPool = POOL_IDS[template.poolIndex] ?? 'a';
  const existing = model.ids[Math.floor(template.idPick * model.ids.length)];
  const id = template.idPick < 0.6 && existing !== undefined ? existing : fromPool;
  switch (template.kind) {
    case 'save':
    case 'create':
      return { kind: template.kind, stack: makeStack(id, template.nameIndex, 'Stack') };
    case 'moveToTrash':
      return { kind: 'moveToTrash', id };
    case 'restoreFromTrash':
      return {
        kind: 'restoreFromTrash',
        slot: pickSlot(template.trashPick, model.trashLength),
        newId: template.useNewId ? NEW_ID_CHOICES[template.newIdIndex] : undefined,
      };
    case 'restoreDemo':
      return {
        kind: 'restoreDemo',
        seeds: POOL_IDS.flatMap((poolId, index) =>
          template.seedMask[index] === true
            ? [{ stack: makeStack(poolId, template.nameIndex, 'Demo') }]
            : [],
        ),
      };
    case 'deleteForever':
      return { kind: 'deleteForever', slot: pickSlot(template.trashPick, model.trashLength) };
    case 'emptyTrash':
      return { kind: 'emptyTrash' };
  }
}

/** Result of a step reduced to what both repositories must agree on. Trash keys are left out. */
type Outcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly codes: readonly string[] };

function withoutKeys(trash: readonly TrashSummary[]): readonly Omit<TrashSummary, 'key'>[] {
  return trash.map(({ id, name, deletedAt }) => ({ id, name, deletedAt }));
}

function outcomeOf<T>(result: Result<T>, value: (v: T) => unknown): Outcome {
  return result.ok
    ? { ok: true, value: value(result.value) }
    : { ok: false, codes: result.errors.map((error) => error.code) };
}

/** Runs one resolved command on one repository. `trashKeys` is that repository's own newest-first list. */
async function apply(
  repository: Repository,
  command: Resolved,
  trashKeys: readonly number[],
  now: number,
): Promise<Outcome> {
  const keyOf = (slot: number | undefined): number =>
    slot === undefined ? MISSING_TRASH_KEY : (trashKeys[slot] ?? MISSING_TRASH_KEY);
  switch (command.kind) {
    case 'save':
      return outcomeOf(await repository.save(command.stack, now), (v) => v);
    case 'create':
      return outcomeOf(await repository.create(command.stack, now), (v) => v);
    case 'moveToTrash':
      return outcomeOf(await repository.moveToTrash(command.id, now), withoutKeys);
    case 'restoreFromTrash':
      return outcomeOf(
        await repository.restoreFromTrash(keyOf(command.slot), now, command.newId),
        (v) => v,
      );
    case 'restoreDemo':
      return outcomeOf(await repository.restoreDemo(command.seeds, now), (v) => ({
        replacedIds: v.replacedIds,
        addedIds: v.addedIds,
        dropped: withoutKeys(v.dropped),
      }));
    case 'deleteForever':
      return outcomeOf(await repository.deleteForever(keyOf(command.slot)), () => undefined);
    case 'emptyTrash':
      return outcomeOf(await repository.emptyTrash(), () => undefined);
  }
}

/** Everything observable after a step, for one repository. */
async function observe(repository: Repository, now: number) {
  const listed = valueOf(await repository.list(now), 'list');
  const trash = valueOf(await repository.listTrash(), 'listTrash');
  return { listed, trash };
}

describe('repositories, model-based sequence (property)', () => {
  it(
    'Feature: local-persistence, Property 4: Model-based sequence',
    async () => {
      // **Validates: Requirements 3, 4, 5.1, 5.6**
      await assertAsyncProperty(
        fc.asyncProperty(arbSequence, async (sequence) => {
          const pair = await openPair();
          try {
            let model: Model = { ids: [], trashLength: 0 };
            let memoryKeys: readonly number[] = [];
            let idbKeys: readonly number[] = [];
            let sawTrash = 0;
            for (const [index, template] of sequence.entries()) {
              const step = `step ${index} (${template.kind})`;
              const now = tick();
              const command = resolveCommand(model, template);

              const fromMemory = await apply(pair.memory, command, memoryKeys, now);
              const fromIdb = await apply(pair.idb, command, idbKeys, now);
              expect(fromIdb, `${step}: outcome`).toEqual(fromMemory);

              const memory = await observe(pair.memory, now);
              const idb = await observe(pair.idb, now);
              expect(idb.listed, `${step}: list`).toEqual(memory.listed);
              expect(withoutKeys(idb.trash), `${step}: trash`).toEqual(withoutKeys(memory.trash));
              expect(memory.listed.problems, `${step}: problems`).toEqual([]);

              for (const { listed, trash, repository, label } of [
                { ...memory, repository: pair.memory, label: 'memory' },
                { ...idb, repository: pair.idb, label: 'idb' },
              ]) {
                expect(trash.length, `${step}: ${label} trash size`).toBeLessThanOrEqual(TRASH_CAP);
                const ids = listed.stacks.map((summary) => summary.id);
                expect(new Set(ids).size, `${step}: ${label} duplicate ids`).toBe(ids.length);
                for (const id of ids) {
                  const loaded = valueOf(await repository.load(id), `${label} load ${id}`);
                  expect(loaded.id, `${step}: ${label} load id`).toBe(id);
                  expect(validateStack(loaded).valid, `${step}: ${label} ${id} valid`).toBe(true);
                }
              }

              sawTrash = Math.max(sawTrash, memory.trash.length);
              memoryKeys = memory.trash.map((record) => record.key);
              idbKeys = idb.trash.map((record) => record.key);
              model = {
                ids: memory.listed.stacks.map((summary) => summary.id),
                trashLength: memory.trash.length,
              };
            }
            expect(sawTrash).toBeLessThanOrEqual(TRASH_CAP);
          } finally {
            await pair.close();
          }
        }),
      );
    },
    TEST_TIMEOUT_MS,
  );
});
