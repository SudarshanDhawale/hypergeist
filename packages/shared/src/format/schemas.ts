import { z } from 'zod';
import { ENTITY_ID_PATTERN, LIMITS } from './limits.ts';
import { codePointLength } from './text.ts';

/*
 * Zod 4 schemas for the slice format. They describe structure only. Cross-entity
 * rules (duplicate ids, references, bounds, exactly-one-of) live in the semantic pass.
 * Every object is strict: an unknown property is an error, never silently dropped.
 * Property order follows the requirement text, so a later serializer can use it.
 */

const EntityId = z.string().regex(ENTITY_ID_PATTERN);

/**
 * A string of `min` to `max` characters. `min` is 0 or 1 everywhere, so the UTF-16
 * length check is exact for the minimum. The maximum counts Unicode code points,
 * which `z.string().max()` does not.
 */
function text(min: number, max: number) {
  return z
    .string()
    .min(min)
    .check((ctx) => {
      // UTF-16 length is never smaller than the code point count, so the cheap test goes first.
      if (ctx.value.length > max && codePointLength(ctx.value) > max) {
        ctx.issues.push({
          code: 'too_big',
          origin: 'string',
          maximum: max,
          inclusive: true,
          input: ctx.value,
        });
      }
    });
}

function int(min: number, max: number) {
  return z.int().min(min).max(max);
}

/* Actions. Exactly-one-of pairs are both optional here; the semantic pass checks them. */

export const GoToCardActionSchema = z.strictObject({
  type: z.literal('go_to_card'),
  cardId: EntityId,
});

export const SetValueActionSchema = z.strictObject({
  type: z.literal('set_value'),
  targetObjectId: EntityId,
  value: text(LIMITS.setValueText.min, LIMITS.setValueText.max).optional(),
  fromObjectId: EntityId.optional(),
});

export const AppendItemActionSchema = z.strictObject({
  type: z.literal('append_item'),
  targetObjectId: EntityId,
  item: text(LIMITS.appendItemText.min, LIMITS.appendItemText.max).optional(),
  fromObjectId: EntityId.optional(),
});

export const ShowMessageActionSchema = z.strictObject({
  type: z.literal('show_message'),
  text: text(LIMITS.messageText.min, LIMITS.messageText.max),
});

export const ActionSchema = z.discriminatedUnion('type', [
  GoToCardActionSchema,
  SetValueActionSchema,
  AppendItemActionSchema,
  ShowMessageActionSchema,
]);

export const HandlerSchema = z.array(ActionSchema).max(LIMITS.handlerActions.max);

/* Objects. */

const objectBase = {
  id: EntityId,
  name: text(LIMITS.objectName.min, LIMITS.objectName.max),
  x: int(LIMITS.objectPosition.min, LIMITS.objectPosition.max),
  y: int(LIMITS.objectPosition.min, LIMITS.objectPosition.max),
  width: int(LIMITS.objectSize.min, LIMITS.objectSize.max),
  height: int(LIMITS.objectSize.min, LIMITS.objectSize.max),
};

export const ButtonSchema = z.strictObject({
  id: objectBase.id,
  type: z.literal('button'),
  name: objectBase.name,
  x: objectBase.x,
  y: objectBase.y,
  width: objectBase.width,
  height: objectBase.height,
  label: text(LIMITS.buttonLabel.min, LIMITS.buttonLabel.max),
  onClick: HandlerSchema,
});

export const FieldSchema = z.strictObject({
  id: objectBase.id,
  type: z.literal('field'),
  name: objectBase.name,
  x: objectBase.x,
  y: objectBase.y,
  width: objectBase.width,
  height: objectBase.height,
  value: text(LIMITS.fieldValue.min, LIMITS.fieldValue.max),
  placeholder: text(LIMITS.fieldPlaceholder.min, LIMITS.fieldPlaceholder.max),
  multiline: z.boolean(),
  readOnly: z.boolean(),
});

export const ListSchema = z.strictObject({
  id: objectBase.id,
  type: z.literal('list'),
  name: objectBase.name,
  x: objectBase.x,
  y: objectBase.y,
  width: objectBase.width,
  height: objectBase.height,
  items: z.array(text(LIMITS.listItemText.min, LIMITS.listItemText.max)).max(LIMITS.listItems.max),
  ordered: z.boolean(),
});

export const ObjectSchema = z.discriminatedUnion('type', [ButtonSchema, FieldSchema, ListSchema]);

/* Link, Card, Stack. */

export const LinkSchema = z.strictObject({
  id: EntityId,
  label: text(LIMITS.linkLabel.min, LIMITS.linkLabel.max),
  targetCardId: EntityId,
});

export const CardSchema = z.strictObject({
  id: EntityId,
  name: text(LIMITS.cardName.min, LIMITS.cardName.max),
  objects: z.array(ObjectSchema).max(LIMITS.objectsPerCard.max),
  links: z.array(LinkSchema).max(LIMITS.linksPerCard.max),
  onOpen: HandlerSchema,
});

export const StackSchema = z.strictObject({
  formatVersion: z.literal(1),
  id: EntityId,
  name: text(LIMITS.stackName.min, LIMITS.stackName.max),
  cardWidth: int(LIMITS.cardSize.min, LIMITS.cardSize.max),
  cardHeight: int(LIMITS.cardSize.min, LIMITS.cardSize.max),
  startCardId: EntityId,
  remixedFrom: EntityId.optional(),
  cards: z.array(CardSchema).min(LIMITS.cards.min).max(LIMITS.cards.max),
});

/* Types, all derived from the schemas. */

export type GoToCardAction = z.infer<typeof GoToCardActionSchema>;
export type SetValueAction = z.infer<typeof SetValueActionSchema>;
export type AppendItemAction = z.infer<typeof AppendItemActionSchema>;
export type ShowMessageAction = z.infer<typeof ShowMessageActionSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type Handler = z.infer<typeof HandlerSchema>;
export type ButtonObject = z.infer<typeof ButtonSchema>;
export type FieldObject = z.infer<typeof FieldSchema>;
export type ListObject = z.infer<typeof ListSchema>;
export type StackObject = z.infer<typeof ObjectSchema>;
export type Link = z.infer<typeof LinkSchema>;
export type Card = z.infer<typeof CardSchema>;
export type Stack = z.infer<typeof StackSchema>;
