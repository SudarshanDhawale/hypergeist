import type { Stack } from '../format/index.ts';

export type IdKind = 'card' | 'obj' | 'link';

/** Every Entity_ID of every Card, Object and Link. Ids are unique across kinds. */
export function collectEntityIds(stack: Stack): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const card of stack.cards) {
    ids.add(card.id);
    for (const object of card.objects) {
      ids.add(object.id);
    }
    for (const link of card.links) {
      ids.add(link.id);
    }
  }
  return ids;
}

/**
 * `<kind>-<n>` with the smallest positive integer n that is not in `used`.
 * Deterministic: no randomness and no clock. Makes at most `used.size + 1` probes.
 */
export function nextEntityId(used: ReadonlySet<string>, kind: IdKind): string {
  let n = 1;
  while (used.has(`${kind}-${n}`)) {
    n += 1;
  }
  return `${kind}-${n}`;
}
