import { z } from 'zod';
import {
  AiFieldSchema,
  ButtonSchema,
  CardSchema,
  FieldSchema,
  HandlerSchema,
  ImageSchema,
  LIMITS,
  LinkSchema,
  ListSchema,
  OBJECT_TYPES,
} from '../../format/index.ts';

/*
 * Zod 4 parameter schemas of the Operations. Each one is a strict object, so an unknown
 * parameter is an error. Property schemas come from the format, so bounds, patterns and
 * `maxLength` metadata have one definition. No `.default()`, `.transform()`, `.refine()`
 * or `.pipe()`: they do not survive `z.toJSONSchema` (see the design, "Operation_Schema
 * content rules"). Cross-field rules live in stage B of each Operation.
 *
 * The descriptions are written for an AI reader: each states the meaning, the type and
 * the constraints of the parameter. A top-level description is at most 1,000 characters
 * and a parameter description at most 500.
 */

/** The Entity_ID schema of the format (the `id` of a Card), reused for every id parameter. */
const entityId = CardSchema.shape.id;

/** `index` of `create_card`: an integer from 0. The upper bound depends on the Stack. */
const insertIndex = z.int().min(0);

export const CreateCardParamsSchema = z
  .strictObject({
    name: CardSchema.shape.name.meta({
      description: `The display name of the new Card. A string of 1 to ${LIMITS.cardName.max} characters. Required.`,
    }),
    id: entityId
      .meta({
        description:
          'The Entity_ID of the new Card: lowercase letters, digits, "_" and "-", starting with a letter or digit, 1 to 64 characters. It must not be used by any Card, Object or Link. Optional. When omitted, the next free "card-<n>" is assigned.',
      })
      .optional(),
    index: insertIndex
      .meta({
        description: `The zero-based position at which the Card is inserted. An integer from 0 up to the current number of Cards (inclusive); the Cards at that position and after it move one place later. Optional. When omitted, the Card is added at the end. A Stack holds at most ${LIMITS.cards.max} Cards.`,
      })
      .optional(),
  })
  .meta({
    description:
      'Create a new empty Card (no Objects, no Links, no onOpen Actions) in the Stack. The start Card does not change. Returns the id of the new Card.',
  });

export const DeleteCardParamsSchema = z
  .strictObject({
    cardId: entityId.meta({
      description:
        'The Entity_ID of the Card to delete. A string that must be the id of an existing Card (not an Object or a Link). The Stack must have at least 2 Cards. Required.',
    }),
  })
  .meta({
    description:
      'Delete a Card together with its Objects and Links. Also removes every Link that points to the Card, and every Action that refers to the Card or to its Objects. If the deleted Card is the start Card, the first remaining Card becomes the start Card. The last Card of a Stack cannot be deleted.',
  });

export const RemoveObjectParamsSchema = z
  .strictObject({
    objectId: entityId.meta({
      description:
        'The Entity_ID of the Object to remove. A string that must be the id of an existing Object (not a Card or a Link). Required.',
    }),
  })
  .meta({
    description:
      'Remove one Object from its Card. Also removes every Action that refers to the Object and removes the Object from the inputObjectIds of every ai-field.',
  });

export const LinkCardsParamsSchema = z
  .strictObject({
    fromCardId: entityId.meta({
      description: `The Entity_ID of the source Card, which receives the Link. A string that must be the id of an existing Card. The Card holds at most ${LIMITS.linksPerCard.max} Links. Required.`,
    }),
    toCardId: entityId.meta({
      description:
        'The Entity_ID of the target Card that the Link opens. A string that must be the id of an existing Card. It may equal fromCardId. The source Card must not already have a Link to this Card. Required.',
    }),
    label: LinkSchema.shape.label.meta({
      description: `The text shown on the Link. A string of 1 to ${LIMITS.linkLabel.max} characters. Required.`,
    }),
    id: entityId
      .meta({
        description:
          'The Entity_ID of the new Link: lowercase letters, digits, "_" and "-", starting with a letter or digit, 1 to 64 characters. It must not be used by any Card, Object or Link. Optional. When omitted, the next free "link-<n>" is assigned.',
      })
      .optional(),
  })
  .meta({
    description:
      'Add a navigation Link from one Card to another. The Link is appended after the existing Links of the source Card. A Card can have only one Link to a given target Card.',
  });

export const SetActionParamsSchema = z
  .strictObject({
    ownerId: entityId.meta({
      description:
        'The Entity_ID of the owner of the Handler. A string that must be the id of an existing Button (its onClick Handler is replaced) or an existing Card (its onOpen Handler is replaced). Required.',
    }),
    handler: HandlerSchema.meta({
      description: `The new Handler: an ordered list of at most ${LIMITS.handlerActions.max} Actions that run in order. Each Action is an object with a "type" (go_to_card, set_value, append_item, remove_item, show_message, run_ai_field, fetch_news, transcribe_audio or schedule_notification) and the properties of that type. Entity ids in Actions must exist in the Stack. An empty array clears the Handler. Required.`,
    }),
  })
  .meta({
    description:
      'Replace the whole Handler of a Button (onClick) or a Card (onOpen) with a new list of Actions. The old Handler is discarded, not merged. Applying the same call twice gives the same result.',
  });

/*
 * `add_object` and `update_object`. Both share one table of Object property schemas, taken
 * from the format so limits and patterns have one definition. The Object types do not share
 * a schema here: `add_object` is one flat object (a root `oneOf` is rejected by many model
 * providers), and which properties a `type` accepts is checked in stage B. Defaults are
 * applied in code (`OBJECT_DEFAULTS`), never with `.default()`.
 */

/** The `name` property is the same schema on every Object type. */
const objectName = ButtonSchema.shape.name;

/** Description texts per mode: `add_object` states what is required, `update_object` does not. */
type Mode = 'add' | 'update';

/**
 * The Object properties that belong to one or more types, each with an AI-reader description.
 * Built per mode so the descriptions fit the Operation that carries them.
 */
function typeProperties(mode: Mode) {
  const need = (text: string) => (mode === 'add' ? ` ${text}` : '');
  return {
    label: ButtonSchema.shape.label.meta({
      description: `Button only. The text shown on the button. A string of ${LIMITS.buttonLabel.min} to ${LIMITS.buttonLabel.max} characters.${need('Required for type "button"; not accepted for other types.')}`,
    }),
    onClick: ButtonSchema.shape.onClick.meta({
      description: `Button only. The Handler that runs when the button is clicked: an ordered list of at most ${LIMITS.handlerActions.max} Actions. Entity ids in Actions must exist in the Stack.${need('Optional; defaults to an empty list.')}`,
    }),
    value: FieldSchema.shape.value.meta({
      description: `Field and ai-field only. The text content. A string of at most ${LIMITS.fieldValue.max} characters.${need('Optional; defaults to an empty string. Not accepted for other types.')}`,
    }),
    placeholder: FieldSchema.shape.placeholder.meta({
      description: `Field only. The hint shown while the field is empty. A string of at most ${LIMITS.fieldPlaceholder.max} characters.${need('Optional; defaults to an empty string. Not accepted for other types.')}`,
    }),
    multiline: FieldSchema.shape.multiline.meta({
      description: `Field only. True for a multi-line text area, false for a single line. A boolean.${need('Optional; defaults to false. Not accepted for other types.')}`,
    }),
    readOnly: FieldSchema.shape.readOnly.meta({
      description: `Field only. True when the user cannot type in the field. A boolean.${need('Optional; defaults to false. Not accepted for other types.')}`,
    }),
    items: ListSchema.shape.items.meta({
      description: `List only. The list entries, in order. An array of at most ${LIMITS.listItems.max} strings of at most ${LIMITS.listItemText.max} characters each.${need('Optional; defaults to an empty list. Not accepted for other types.')}`,
    }),
    ordered: ListSchema.shape.ordered.meta({
      description: `List only. True to number the entries, false for bullets. A boolean.${need('Optional; defaults to false. Not accepted for other types.')}`,
    }),
    src: ImageSchema.shape.src.meta({
      description: `Image only. The image source: an "https:" URL of at most ${LIMITS.imageHttpsSrc.max} characters, or a "data:image/..." URL of a supported image type.${need('Required for type "image"; not accepted for other types.')}`,
    }),
    alt: ImageSchema.shape.alt.meta({
      description: `Image only. The alternative text that describes the image. A string of at most ${LIMITS.imageAlt.max} characters.${need('Optional; defaults to an empty string. Not accepted for other types.')}`,
    }),
    prompt: AiFieldSchema.shape.prompt.meta({
      description: `Ai-field only. The instruction the AI follows to fill the field. A string of ${LIMITS.aiPrompt.min} to ${LIMITS.aiPrompt.max} characters.${need('Required for type "ai-field"; not accepted for other types.')}`,
    }),
    inputObjectIds: AiFieldSchema.shape.inputObjectIds.meta({
      description: `Ai-field only. The Entity_IDs of Objects on the same Card whose text is sent to the AI with the prompt. An array of at most ${LIMITS.aiInputObjects.max} unique ids.${need('Optional; defaults to an empty list. Not accepted for other types.')}`,
    }),
  };
}

/** The properties every Object type has, except `id` and `type`, which are never changed. */
function sharedProperties(mode: Mode) {
  const verb = mode === 'add' ? 'of the new Object' : 'to set';
  return {
    name: objectName.meta({
      description: `The name ${verb}, shown in the editor and sent to the AI as the label of an input. A string of at most ${LIMITS.objectName.max} characters. All types.${mode === 'add' ? ' Optional; defaults to an empty string.' : ''}`,
    }),
    x: ButtonSchema.shape.x.meta({
      description: `The horizontal position ${mode === 'add' ? 'of the left edge' : 'to set (left edge)'} on the Card, in pixels. An integer from ${LIMITS.objectPosition.min} to ${LIMITS.objectPosition.max}. All types.${mode === 'add' ? ' Required.' : ''} The Object must fit inside the Card.`,
    }),
    y: ButtonSchema.shape.y.meta({
      description: `The vertical position ${mode === 'add' ? 'of the top edge' : 'to set (top edge)'} on the Card, in pixels. An integer from ${LIMITS.objectPosition.min} to ${LIMITS.objectPosition.max}. All types.${mode === 'add' ? ' Required.' : ''} The Object must fit inside the Card.`,
    }),
    width: ButtonSchema.shape.width.meta({
      description: `The width ${mode === 'add' ? 'of the Object' : 'to set'}, in pixels. An integer from ${LIMITS.objectSize.min} to ${LIMITS.objectSize.max}. All types.${mode === 'add' ? ' Required.' : ''} The Object must fit inside the Card.`,
    }),
    height: ButtonSchema.shape.height.meta({
      description: `The height ${mode === 'add' ? 'of the Object' : 'to set'}, in pixels. An integer from ${LIMITS.objectSize.min} to ${LIMITS.objectSize.max}. All types.${mode === 'add' ? ' Required.' : ''} The Object must fit inside the Card.`,
    }),
  };
}

const addShared = sharedProperties('add');
const addTyped = typeProperties('add');

export const AddObjectParamsSchema = z
  .strictObject({
    cardId: entityId.meta({
      description: `The Entity_ID of the Card that receives the Object. A string that must be the id of an existing Card. The Card holds at most ${LIMITS.objectsPerCard.max} Objects. Required.`,
    }),
    type: z.enum(OBJECT_TYPES).meta({
      description: `The kind of Object to add. One of: ${OBJECT_TYPES.join(', ')}. It decides which of the type-specific parameters are required or accepted. Required.`,
    }),
    x: addShared.x,
    y: addShared.y,
    width: addShared.width,
    height: addShared.height,
    id: entityId
      .meta({
        description:
          'The Entity_ID of the new Object: lowercase letters, digits, "_" and "-", starting with a letter or digit, 1 to 64 characters. It must not be used by any Card, Object or Link. Optional. When omitted, the next free "obj-<n>" is assigned.',
      })
      .optional(),
    index: insertIndex
      .meta({
        description:
          'The zero-based position of the Object in the Card, which sets its stacking order. An integer from 0 up to the current number of Objects on the Card (inclusive). Optional. When omitted, the Object is added at the end.',
      })
      .optional(),
    name: addShared.name.optional(),
    label: addTyped.label.optional(),
    onClick: addTyped.onClick.optional(),
    value: addTyped.value.optional(),
    placeholder: addTyped.placeholder.optional(),
    multiline: addTyped.multiline.optional(),
    readOnly: addTyped.readOnly.optional(),
    items: addTyped.items.optional(),
    ordered: addTyped.ordered.optional(),
    src: addTyped.src.optional(),
    alt: addTyped.alt.optional(),
    prompt: addTyped.prompt.optional(),
    inputObjectIds: addTyped.inputObjectIds.optional(),
  })
  .meta({
    description:
      'Add one Object to a Card. Always give cardId, type, x, y, width and height. Then give the properties of the chosen type: a button needs label, an image needs src, an ai-field needs prompt; a field and a list need nothing more. Properties of another type are rejected. Omitted optional properties get their defaults. Returns the id of the new Object.',
  });

const updateShared = sharedProperties('update');
const updateTyped = typeProperties('update');

/** The mutable properties of every Object type, all optional. `id` and `type` are not in it. */
const ObjectChangesSchema = z
  .strictObject({
    name: updateShared.name.optional(),
    x: updateShared.x.optional(),
    y: updateShared.y.optional(),
    width: updateShared.width.optional(),
    height: updateShared.height.optional(),
    label: updateTyped.label.optional(),
    onClick: updateTyped.onClick.optional(),
    value: updateTyped.value.optional(),
    placeholder: updateTyped.placeholder.optional(),
    multiline: updateTyped.multiline.optional(),
    readOnly: updateTyped.readOnly.optional(),
    items: updateTyped.items.optional(),
    ordered: updateTyped.ordered.optional(),
    src: updateTyped.src.optional(),
    alt: updateTyped.alt.optional(),
    prompt: updateTyped.prompt.optional(),
    inputObjectIds: updateTyped.inputObjectIds.optional(),
  })
  .meta({
    description:
      'The properties to replace. Use only properties of the Object\'s type: name, x, y, width, height (all types); label, onClick (button); value, placeholder, multiline, readOnly (field); items, ordered (list); src, alt (image); prompt, inputObjectIds, value (ai-field). "id" and "type" cannot change. An empty object changes nothing.',
  });

export const UpdateObjectParamsSchema = z
  .strictObject({
    objectId: entityId.meta({
      description:
        'The Entity_ID of the Object to change. A string that must be the id of an existing Object (not a Card or a Link). Required.',
    }),
    changes: ObjectChangesSchema,
  })
  .meta({
    description:
      'Replace some properties of an existing Object. Properties not named in changes stay as they are. The Object keeps its id, its type and its position in the Card. The result must still be valid, for example the Object must fit inside the Card.',
  });

export type CreateCardParams = z.infer<typeof CreateCardParamsSchema>;
export type DeleteCardParams = z.infer<typeof DeleteCardParamsSchema>;
export type RemoveObjectParams = z.infer<typeof RemoveObjectParamsSchema>;
export type LinkCardsParams = z.infer<typeof LinkCardsParamsSchema>;
export type SetActionParams = z.infer<typeof SetActionParamsSchema>;
export type AddObjectParams = z.infer<typeof AddObjectParamsSchema>;
export type UpdateObjectParams = z.infer<typeof UpdateObjectParamsSchema>;
