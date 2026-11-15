import { createValidationError } from '../format/index.ts';
import type {
  AiFieldObject,
  ButtonObject,
  FieldObject,
  ImageObject,
  Link,
  ListObject,
  Stack,
  StackObject,
  ValidationError,
} from '../format/index.ts';
import { deepCopyJson } from './clone.ts';

/** One ai-field input: the Object's id and its name. */
export type RenderInput = { readonly id: string; readonly name: string };

/** An ai-field plus the resolved `{ id, name }` of each of its inputs, in `inputObjectIds` order. */
export type RenderAiField = AiFieldObject & { readonly inputs: readonly RenderInput[] };

export type RenderObject = ButtonObject | FieldObject | ImageObject | ListObject | RenderAiField;

/** A Link plus the name of the Card it points to. */
export type RenderLink = Link & { readonly targetCardName: string };

export type RenderModel = {
  readonly cardWidth: number;
  readonly cardHeight: number;
  readonly id: string;
  readonly name: string;
  /** Array order of the Card: first Object at the back, last Object at the front. */
  readonly objects: readonly RenderObject[];
  readonly links: readonly RenderLink[];
};

export type RenderModelResult =
  | { readonly ok: true; readonly model: RenderModel }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

/** How many valid card ids a hint lists. */
const HINT_ID_LIMIT = 20;

/** Copies one Object and, for an ai-field, adds its resolved inputs. */
function toRenderObject(object: StackObject, siblings: ReadonlyMap<string, string>): RenderObject {
  const copy = deepCopyJson(object);
  if (copy.type !== 'ai-field') {
    return copy;
  }
  const inputs: RenderInput[] = [];
  for (const id of copy.inputObjectIds) {
    // An unresolved id (invalid Stack) falls back to an empty name; the builder never throws.
    inputs.push({ id, name: siblings.get(id) ?? '' });
  }
  return { ...copy, inputs };
}

/**
 * Builds the plain, JSON-safe description of one Card, ready to draw.
 *
 * The model is a deep copy: it shares no object or array with the Stack, and
 * Object positions and sizes are copied as stored (never clipped). A `cardId`
 * that is not a Card (including an Object or Link id) gives `UNKNOWN_ENTITY`
 * at `/cardId`. On an invalid Stack the builder still does not throw.
 */
export function buildRenderModel(stack: Stack, cardId: string): RenderModelResult {
  const card = stack.cards.find((candidate) => candidate.id === cardId);
  if (card === undefined) {
    const known = stack.cards.slice(0, HINT_ID_LIMIT).map((candidate) => candidate.id);
    return {
      ok: false,
      errors: [
        createValidationError({
          code: 'UNKNOWN_ENTITY',
          path: '/cardId',
          message: `No card has the id "${cardId}".`,
          expected: 'the id of a card of the stack',
          actual: cardId,
          hint: `Use one of the existing card ids: ${known.join(', ')}`,
        }),
      ],
    };
  }

  const objectNames = new Map<string, string>();
  for (const object of card.objects) {
    objectNames.set(object.id, object.name);
  }
  const cardNames = new Map<string, string>();
  for (const candidate of stack.cards) {
    cardNames.set(candidate.id, candidate.name);
  }

  const objects = card.objects.map((object) => toRenderObject(object, objectNames));
  const links = card.links.map((link): RenderLink => ({
    ...deepCopyJson(link),
    targetCardName: cardNames.get(link.targetCardId) ?? '',
  }));

  return {
    ok: true,
    model: {
      cardWidth: stack.cardWidth,
      cardHeight: stack.cardHeight,
      id: card.id,
      name: card.name,
      objects,
      links,
    },
  };
}
