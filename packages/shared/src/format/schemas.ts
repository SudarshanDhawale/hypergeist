import { z } from 'zod';
import { ENTITY_ID_PATTERN, IMAGE_SRC_PATTERN, LIMITS } from './limits.ts';
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
  return (
    z
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
      })
      // A custom check is invisible to z.toJSONSchema, so the maximum is added as metadata.
      .meta({ maxLength: max })
  );
}

/**
 * An array whose maximum size is enforced by the semantic pass, not by Zod.
 * Zod checks an array's maximum before it parses any element, so `.max()` would hide
 * every element error in an oversize array. The `maxItems` metadata keeps the bound in
 * the JSON Schema. A minimum may be added with the built-in `.min()`.
 */
function limitedArray<T extends z.ZodType>(element: T, max: number) {
  return z.array(element).meta({ maxItems: max });
}

function int(min: number, max: number) {
  return z.int().min(min).max(max);
}

/**
 * An image source: the pattern and the overall maximum come from the built-in checks.
 * The pattern is ASCII only, so UTF-16 length equals the code point count. A pattern
 * cannot say "an `https:` source has at most 2,000 characters", so a custom check adds
 * that `too_big` issue. A string that is too long and does not match reports both issues.
 */
const imageSrc = z
  .string()
  .regex(IMAGE_SRC_PATTERN)
  .max(LIMITS.imageDataSrc.max)
  .check((ctx) => {
    if (ctx.value.startsWith('https:') && ctx.value.length > LIMITS.imageHttpsSrc.max) {
      ctx.issues.push({
        code: 'too_big',
        origin: 'string',
        maximum: LIMITS.imageHttpsSrc.max,
        inclusive: true,
        input: ctx.value,
      });
    }
  });

/* Actions. Exactly-one-of pairs are both optional here; the semantic pass checks them. */

export const GoToCardActionSchema = z.strictObject({
  type: z.literal('go_to_card'),
  cardId: EntityId,
});

export const SetValueActionSchema = z
  .strictObject({
    type: z.literal('set_value'),
    targetObjectId: EntityId,
    value: text(LIMITS.setValueText.min, LIMITS.setValueText.max).optional(),
    fromObjectId: EntityId.optional(),
  })
  .meta({ oneOf: [{ required: ['value'] }, { required: ['fromObjectId'] }] });

export const AppendItemActionSchema = z
  .strictObject({
    type: z.literal('append_item'),
    targetObjectId: EntityId,
    item: text(LIMITS.appendItemText.min, LIMITS.appendItemText.max).optional(),
    fromObjectId: EntityId.optional(),
  })
  .meta({ oneOf: [{ required: ['item'] }, { required: ['fromObjectId'] }] });

export const RemoveItemActionSchema = z.strictObject({
  type: z.literal('remove_item'),
  targetObjectId: EntityId,
  index: z.int().min(LIMITS.removeItemIndex.min),
});

export const ShowMessageActionSchema = z.strictObject({
  type: z.literal('show_message'),
  text: text(LIMITS.messageText.min, LIMITS.messageText.max),
});

export const RunAiFieldActionSchema = z.strictObject({
  type: z.literal('run_ai_field'),
  targetObjectId: EntityId,
});

export const FetchNewsActionSchema = z.strictObject({
  type: z.literal('fetch_news'),
  targetObjectId: EntityId,
  topics: limitedArray(
    text(LIMITS.newsTopicText.min, LIMITS.newsTopicText.max),
    LIMITS.newsTopics.max,
  ).min(LIMITS.newsTopics.min),
});

export const TranscribeAudioActionSchema = z.strictObject({
  type: z.literal('transcribe_audio'),
  targetObjectId: EntityId,
});

export const ScheduleNotificationActionSchema = z
  .strictObject({
    type: z.literal('schedule_notification'),
    message: text(LIMITS.notificationMessage.min, LIMITS.notificationMessage.max),
    at: z.iso.datetime().optional(),
    atFromObjectId: EntityId.optional(),
  })
  .meta({ oneOf: [{ required: ['at'] }, { required: ['atFromObjectId'] }] });

export const ActionSchema = z.discriminatedUnion('type', [
  GoToCardActionSchema,
  SetValueActionSchema,
  AppendItemActionSchema,
  RemoveItemActionSchema,
  ShowMessageActionSchema,
  RunAiFieldActionSchema,
  FetchNewsActionSchema,
  TranscribeAudioActionSchema,
  ScheduleNotificationActionSchema,
]);

export const HandlerSchema = limitedArray(ActionSchema, LIMITS.handlerActions.max);

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
  items: limitedArray(text(LIMITS.listItemText.min, LIMITS.listItemText.max), LIMITS.listItems.max),
  ordered: z.boolean(),
});

export const ImageSchema = z.strictObject({
  id: objectBase.id,
  type: z.literal('image'),
  name: objectBase.name,
  x: objectBase.x,
  y: objectBase.y,
  width: objectBase.width,
  height: objectBase.height,
  src: imageSrc,
  alt: text(LIMITS.imageAlt.min, LIMITS.imageAlt.max),
});

export const AiFieldSchema = z.strictObject({
  id: objectBase.id,
  type: z.literal('ai-field'),
  name: objectBase.name,
  x: objectBase.x,
  y: objectBase.y,
  width: objectBase.width,
  height: objectBase.height,
  prompt: text(LIMITS.aiPrompt.min, LIMITS.aiPrompt.max),
  inputObjectIds: limitedArray(EntityId, LIMITS.aiInputObjects.max).meta({ uniqueItems: true }),
  value: text(LIMITS.aiFieldValue.min, LIMITS.aiFieldValue.max),
});

export const ObjectSchema = z.discriminatedUnion('type', [
  ButtonSchema,
  FieldSchema,
  ImageSchema,
  ListSchema,
  AiFieldSchema,
]);

/* Link, Card, Stack. */

export const LinkSchema = z.strictObject({
  id: EntityId,
  label: text(LIMITS.linkLabel.min, LIMITS.linkLabel.max),
  targetCardId: EntityId,
});

export const CardSchema = z.strictObject({
  id: EntityId,
  name: text(LIMITS.cardName.min, LIMITS.cardName.max),
  objects: limitedArray(ObjectSchema, LIMITS.objectsPerCard.max),
  links: limitedArray(LinkSchema, LIMITS.linksPerCard.max),
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
  cards: limitedArray(CardSchema, LIMITS.cards.max).min(LIMITS.cards.min),
});

/* Types, all derived from the schemas. */

export type GoToCardAction = z.infer<typeof GoToCardActionSchema>;
export type SetValueAction = z.infer<typeof SetValueActionSchema>;
export type AppendItemAction = z.infer<typeof AppendItemActionSchema>;
export type RemoveItemAction = z.infer<typeof RemoveItemActionSchema>;
export type ShowMessageAction = z.infer<typeof ShowMessageActionSchema>;
export type RunAiFieldAction = z.infer<typeof RunAiFieldActionSchema>;
export type FetchNewsAction = z.infer<typeof FetchNewsActionSchema>;
export type TranscribeAudioAction = z.infer<typeof TranscribeAudioActionSchema>;
export type ScheduleNotificationAction = z.infer<typeof ScheduleNotificationActionSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type Handler = z.infer<typeof HandlerSchema>;
export type ButtonObject = z.infer<typeof ButtonSchema>;
export type FieldObject = z.infer<typeof FieldSchema>;
export type ImageObject = z.infer<typeof ImageSchema>;
export type ListObject = z.infer<typeof ListSchema>;
export type AiFieldObject = z.infer<typeof AiFieldSchema>;
export type StackObject = z.infer<typeof ObjectSchema>;
export type Link = z.infer<typeof LinkSchema>;
export type Card = z.infer<typeof CardSchema>;
export type Stack = z.infer<typeof StackSchema>;
