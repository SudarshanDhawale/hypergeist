import { LIMITS, createValidationError } from '../../format/index.ts';
import type { Link, ValidationError } from '../../format/index.ts';
import { collectEntityIds, nextEntityId } from '../ids.ts';
import { emptySummary, unknownEntityError } from '../operation-result.ts';
import type { OperationDefinition } from './definition.ts';
import { LinkCardsParamsSchema } from './params.ts';
import type { LinkCardsParams } from './params.ts';

/**
 * `link_cards`: appends a Link to `fromCardId` that opens `toCardId`. A Link to the same Card
 * is allowed. All precondition errors are collected.
 */
export const linkCardsDefinition: OperationDefinition<LinkCardsParams> = {
  name: 'link_cards',
  schema: LinkCardsParamsSchema,
  rangePaths: [],
  run: (stack, params) => {
    const cardIds = stack.cards.map((card) => card.id);
    const fromIndex = cardIds.indexOf(params.fromCardId);
    const toIndex = cardIds.indexOf(params.toCardId);
    const source = stack.cards[fromIndex];
    const errors: ValidationError[] = [];

    if (source === undefined) {
      errors.push(unknownEntityError('/fromCardId', params.fromCardId, 'Card', cardIds));
    }
    if (toIndex < 0) {
      errors.push(unknownEntityError('/toCardId', params.toCardId, 'Card', cardIds));
    }

    if (source !== undefined) {
      if (toIndex >= 0 && source.links.some((link) => link.targetCardId === params.toCardId)) {
        errors.push(
          createValidationError({
            code: 'DUPLICATE_LINK',
            path: '/toCardId',
            message: `The Card "${source.id}" already has a Link to "${params.toCardId}".`,
            expected: 'a target Card that the source Card does not link to yet',
            actual: params.toCardId,
            hint: 'A Card can have only one Link to a given Card. Choose another target, or update the existing Link.',
          }),
        );
      }
      if (source.links.length >= LIMITS.linksPerCard.max) {
        errors.push(
          createValidationError({
            code: 'LIMIT_EXCEEDED',
            path: '/fromCardId',
            message: `The Card "${source.id}" already has the maximum of ${LIMITS.linksPerCard.max} Links.`,
            expected: `at most ${LIMITS.linksPerCard.max} Links per Card after the Operation`,
            actual: source.links.length,
            hint: 'Choose another source Card.',
          }),
        );
      }
    }

    const used = collectEntityIds(stack);
    if (params.id !== undefined && used.has(params.id)) {
      errors.push(
        createValidationError({
          code: 'DUPLICATE_ID',
          path: '/id',
          message: `The id "${params.id}" is already used by a Card, an Object or a Link.`,
          expected: 'an Entity_ID that no Card, Object or Link of the Stack uses',
          actual: params.id,
          hint: 'Choose a different id, or omit "id" to get the next free "link-<n>".',
        }),
      );
    }

    if (errors.length > 0 || source === undefined) return { ok: false, errors };

    const id = params.id ?? nextEntityId(used, 'link');
    const link: Link = { id, label: params.label, targetCardId: params.toCardId };
    const linkIndex = source.links.length;
    const prefix = `/cards/${fromIndex}/links/${linkIndex}`;

    return {
      ok: true,
      candidate: {
        ...stack,
        cards: stack.cards.map((card, index) =>
          index === fromIndex ? { ...card, links: [...card.links, link] } : card,
        ),
      },
      summary: { ...emptySummary(), created: [id] },
      mapPath: (pointer) => {
        if (pointer === `${prefix}/id`) return '/id';
        if (pointer === `${prefix}/label`) return '/label';
        if (pointer === `${prefix}/targetCardId`) return '/toCardId';
        return undefined;
      },
    };
  },
};
