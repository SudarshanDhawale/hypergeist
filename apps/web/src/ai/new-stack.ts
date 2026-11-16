import { createStack } from '@hypergeist/shared/engine';
import type { Stack } from '@hypergeist/shared/format';

/** The id of the first new stack. Later ones are `my-stack-2`, `my-stack-3`, and so on. */
const BASE_ID = 'my-stack';

/** The name of a new stack until the model names it with `create_stack`. */
const NEW_STACK_NAME = 'New stack';

/** What `startNewStack` returns: the empty starter stack and the id of its first card. */
export type NewStackStart = {
  readonly stack: Stack;
  readonly currentCardId: string;
};

/**
 * Picks an unused stack id: `my-stack`, then `my-stack-2`, `my-stack-3`, and so on.
 * Every candidate matches the Entity ID pattern. Pure: the same set gives the same id.
 * The loop ends after at most `taken.size + 1` attempts because each candidate is distinct.
 */
export function pickNewStackId(taken: ReadonlySet<string> | readonly string[]): string {
  const takenSet = new Set<string>(taken);
  if (!takenSet.has(BASE_ID)) return BASE_ID;
  for (let attempt = 2; ; attempt += 1) {
    const candidate = `${BASE_ID}-${attempt}`;
    if (!takenSet.has(candidate)) return candidate;
  }
}

/**
 * Makes the empty starter stack for a Turn that builds a new stack: one card, the name
 * "New stack", and an id that is not in `takenIds`. Does not store anything and does not
 * throw for any input.
 */
export function startNewStack(params: {
  readonly takenIds: ReadonlySet<string> | readonly string[];
}): NewStackStart {
  const made = createStack({ id: pickNewStackId(params.takenIds), name: NEW_STACK_NAME });
  if (!made.ok) {
    // Programmer error: the id matches the pattern by construction and the name is fixed, so
    // `createStack` cannot reject these parameters (same reasoning as `boot.ts`).
    throw new Error('createStack rejected the fixed parameters of a new stack.');
  }
  const first = made.stack.cards[0];
  if (first === undefined) {
    // Programmer error: `createStack` always makes one card.
    throw new Error('createStack returned a stack with no card.');
  }
  return { stack: made.stack, currentCardId: first.id };
}
