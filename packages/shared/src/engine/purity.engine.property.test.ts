import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { arbEntityId, arbHandlerFor, arbStack } from '../../test-support/arbitraries.ts';
import { arbCreateStackParams } from '../../test-support/factory-arbitraries.ts';
import { deepCopy, deepFreeze } from '../../test-support/freeze.ts';
import {
  arbOperationTemplate,
  resolveOperation,
} from '../../test-support/operation-arbitraries.ts';
import { assertProperty } from '../../test-support/seed.ts';
import type { Handler, Stack } from '../format/index.ts';
import { createStack } from './create-stack.ts';
import { executeHandler } from './execute-handler.ts';
import { applyOperation } from './operations/index.ts';
import { buildRenderModel } from './render-model.ts';
import { remixStack } from './remix.ts';

type Case = {
  readonly stack: Stack;
  readonly handler: Handler;
  /** Fraction in [0, 1) that picks a Card of the Stack. */
  readonly cardPick: number;
  readonly newId: string;
  readonly template: Parameters<typeof resolveOperation>[1];
};

const arbCase: fc.Arbitrary<Case> = arbStack.chain((stack) =>
  fc
    .record({
      handler: arbHandlerFor(stack, 'all'),
      cardPick: fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
      newId: arbEntityId,
      template: arbOperationTemplate,
    })
    .map((rest) => ({ stack, ...rest })),
);

describe('engine purity and determinism', () => {
  // Feature: stack-engine, Property 3: Engine functions are pure and deterministic
  // **Validates: Requirements 1.3, 1.4, 5.15, 6.7, 8.15, 10.2**
  it('repeats exactly and leaves deeply frozen inputs unchanged', () => {
    assertProperty(
      fc.property(arbCase, arbCreateStackParams, (testCase, createParams) => {
        const stack = deepFreeze(deepCopy(testCase.stack));
        const handler = deepFreeze(deepCopy(testCase.handler));
        const stackBefore = deepCopy(testCase.stack);
        const handlerBefore = deepCopy(testCase.handler);

        const cards = stack.cards;
        const card = cards[Math.floor(testCase.cardPick * cards.length)];
        expect(card).toBeDefined();
        if (card === undefined) return;

        const call = resolveOperation(stack, testCase.template);
        const params = deepFreeze(deepCopy(call.params));
        const paramsBefore = deepCopy(call.params);

        const frozenCreate = deepFreeze(deepCopy(createParams));
        const createBefore = deepCopy(createParams);

        // applyOperation: a frozen Stack and frozen parameters, called twice.
        expect(applyOperation(stack, call.name, params)).toEqual(
          applyOperation(stack, call.name, params),
        );

        // executeHandler: all nine Actions, Effect_Requests returned as data.
        expect(executeHandler(stack, handler)).toEqual(executeHandler(stack, handler));

        // buildRenderModel.
        expect(buildRenderModel(stack, card.id)).toEqual(buildRenderModel(stack, card.id));

        // remixStack.
        expect(remixStack(stack, testCase.newId)).toEqual(remixStack(stack, testCase.newId));

        // createStack.
        expect(createStack(frozenCreate)).toEqual(createStack(frozenCreate));

        // No input was modified. A write to a frozen value would also have thrown.
        expect(stack).toEqual(stackBefore);
        expect(handler).toEqual(handlerBefore);
        expect(params).toEqual(paramsBefore);
        expect(frozenCreate).toEqual(createBefore);
      }),
    );
  });
});
