import { describe, expect, it } from 'vitest';
import type { ValidationError } from '@hypergeist/shared/format';
import { describeCall, describeResult, MAX_NAME_CODE_POINTS } from './describe.ts';

const TOOLS = [
  'create_card',
  'delete_card',
  'add_object',
  'update_object',
  'remove_object',
  'link_cards',
  'set_action',
  'say',
  'create_stack',
] as const;

const LONG = 'x'.repeat(5000);

/** Values a model could send in place of any parameter. */
const HOSTILE_VALUES: readonly unknown[] = [
  undefined,
  null,
  0,
  42,
  -1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  true,
  false,
  '',
  '   ',
  LONG,
  [],
  ['card-1'],
  {},
  { nested: { deep: [1, 2, 3] } },
  () => 'x',
  Symbol('s'),
  10n,
  new Date(0),
  'line one\nline two',
];

function error(message: string): ValidationError {
  return {
    code: 'invalid_value',
    path: '/x',
    message,
    expected: 'e',
    actual: null,
    hint: 'h',
  } as unknown as ValidationError;
}

function codePoints(text: string): number {
  return Array.from(text).length;
}

describe('describeCall: good parameters', () => {
  it('describes create_card with and without a name', () => {
    expect(describeCall('create_card', { name: 'Notes' })).toBe('Created card "Notes"');
    expect(describeCall('create_card', {})).toBe('Created a card');
  });

  it('describes delete_card', () => {
    expect(describeCall('delete_card', { cardId: 'card-2' })).toBe('Deleted card card-2');
    expect(describeCall('delete_card', {})).toBe('Deleted a card');
  });

  it('describes add_object for a button with its label and card', () => {
    expect(
      describeCall('add_object', {
        cardId: 'card-1',
        type: 'button',
        label: 'Add',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      }),
    ).toBe('Added a button "Add" to card-1');
  });

  it('describes add_object for the other types, using the name and the right article', () => {
    expect(describeCall('add_object', { cardId: 'card-1', type: 'image', name: 'Logo' })).toBe(
      'Added an image "Logo" to card-1',
    );
    expect(describeCall('add_object', { cardId: 'card-1', type: 'list' })).toBe(
      'Added a list to card-1',
    );
    expect(describeCall('add_object', { cardId: 'card-1', type: 'field', name: 'Title' })).toBe(
      'Added a field "Title" to card-1',
    );
    expect(describeCall('add_object', { cardId: 'card-1', type: 'ai-field' })).toBe(
      'Added an ai-field to card-1',
    );
  });

  it('describes add_object when the button has no label but has a name, and when the card is missing', () => {
    expect(describeCall('add_object', { type: 'button', name: 'Go' })).toBe('Added a button "Go"');
  });

  it('describes update_object and remove_object', () => {
    expect(describeCall('update_object', { objectId: 'todo-list', changes: {} })).toBe(
      'Changed object todo-list',
    );
    expect(describeCall('remove_object', { objectId: 'todo-list' })).toBe(
      'Removed object todo-list',
    );
    expect(describeCall('update_object', {})).toBe('Changed an object');
    expect(describeCall('remove_object', {})).toBe('Removed an object');
  });

  it('describes link_cards', () => {
    expect(
      describeCall('link_cards', { fromCardId: 'card-1', toCardId: 'card-2', label: 'Next' }),
    ).toBe('Linked card-1 to card-2');
    expect(describeCall('link_cards', { fromCardId: 'card-1' })).toBe('Linked card-1 to a card');
    expect(describeCall('link_cards', {})).toBe('Linked two cards');
  });

  it('describes set_action', () => {
    expect(describeCall('set_action', { ownerId: 'add-btn', handler: [] })).toBe(
      'Set what add-btn does',
    );
    expect(describeCall('set_action', {})).toBe('Set what the button does');
  });

  it('describes say and create_stack', () => {
    expect(describeCall('say', { text: 'Hello there' })).toBe('Said something');
    expect(describeCall('create_stack', { name: 'Groceries' })).toBe('Named the stack "Groceries"');
    expect(describeCall('create_stack', {})).toBe('Named the stack');
  });

  it('does not repeat the text the model said', () => {
    expect(describeCall('say', { text: 'secret sk-abc' })).not.toContain('secret');
  });
});

describe('describeCall: hostile input', () => {
  it('never throws and returns one non-empty line for every tool and every hostile params value', () => {
    for (const tool of TOOLS) {
      for (const params of HOSTILE_VALUES) {
        const line = describeCall(tool, params);
        expect(typeof line).toBe('string');
        expect(line.length).toBeGreaterThan(0);
        expect(line).not.toMatch(/[\n\r]/);
      }
    }
  });

  it('never throws when every parameter is a hostile value', () => {
    for (const tool of TOOLS) {
      for (const value of HOSTILE_VALUES) {
        const params = {
          name: value,
          cardId: value,
          objectId: value,
          fromCardId: value,
          toCardId: value,
          ownerId: value,
          label: value,
          type: value,
        };
        const line = describeCall(tool, params);
        expect(line.length).toBeGreaterThan(0);
        expect(line).not.toMatch(/[\n\r]/);
      }
    }
  });

  it('falls back to the generic line when a parameter is a number, null or an object', () => {
    expect(describeCall('create_card', { name: 5 })).toBe('Created a card');
    expect(describeCall('create_card', { name: null })).toBe('Created a card');
    expect(describeCall('create_card', { name: { a: 1 } })).toBe('Created a card');
    expect(describeCall('delete_card', { cardId: 7 })).toBe('Deleted a card');
    expect(describeCall('create_stack', { name: ['x'] })).toBe('Named the stack');
    expect(describeCall('link_cards', { fromCardId: 1, toCardId: 2 })).toBe('Linked two cards');
  });

  it('treats a params value that is not a plain object as no parameters', () => {
    for (const params of [null, undefined, 3, 'text', ['card-1'], true]) {
      expect(describeCall('create_card', params)).toBe('Created a card');
      expect(describeCall('remove_object', params)).toBe('Removed an object');
    }
  });

  it('cuts every name and id to 40 code points', () => {
    const cut = describeCall('create_card', { name: LONG });
    const name = cut.slice(cut.indexOf('"') + 1, cut.lastIndexOf('"'));
    expect(codePoints(name)).toBe(MAX_NAME_CODE_POINTS);
    expect(name.endsWith('\u2026')).toBe(true);

    const id = describeCall('remove_object', { objectId: LONG });
    expect(codePoints(id.replace('Removed object ', ''))).toBeLessThanOrEqual(MAX_NAME_CODE_POINTS);

    const link = describeCall('link_cards', { fromCardId: LONG, toCardId: LONG });
    expect(link.length).toBeLessThanOrEqual('Linked  to '.length + 2 * MAX_NAME_CODE_POINTS);
  });

  it('keeps a name of exactly 40 code points whole and cuts 41', () => {
    expect(describeCall('create_card', { name: 'a'.repeat(40) })).toBe(
      `Created card "${'a'.repeat(40)}"`,
    );
    expect(describeCall('create_card', { name: 'a'.repeat(41) })).toBe(
      `Created card "${'a'.repeat(39)}\u2026"`,
    );
  });

  it('counts code points, so an emoji name is never cut in the middle of a character', () => {
    const emoji = '\u{1F47B}'.repeat(60);
    const line = describeCall('create_card', { name: emoji });
    const name = line.slice('Created card "'.length, -1);
    expect(codePoints(name)).toBe(MAX_NAME_CODE_POINTS);
    expect(name).toBe(`${'\u{1F47B}'.repeat(39)}\u2026`);
    // No lone surrogate: the text survives a UTF-8 round trip.
    expect(new TextDecoder().decode(new TextEncoder().encode(name))).toBe(name);
  });

  it('puts the description on one line: newlines, tabs and control characters become one space', () => {
    expect(describeCall('create_card', { name: 'a\n\n b\tc\u0000d\u2028e' })).toBe(
      'Created card "a b c d e"',
    );
    expect(describeCall('create_card', { name: '\n  padded \r\n' })).toBe('Created card "padded"');
  });

  it('drops zero-width and bidi control characters', () => {
    expect(describeCall('create_card', { name: 'a\u200Bb\u202Ec\uFEFFd' })).toBe(
      'Created card "abcd"',
    );
  });

  it('treats a name of only blanks as missing', () => {
    expect(describeCall('create_card', { name: ' \n\t ' })).toBe('Created a card');
  });

  it('does not echo an unknown Object type', () => {
    expect(describeCall('add_object', { cardId: 'c', type: 'script<img>' })).toBe(
      'Added an object to c',
    );
    expect(describeCall('add_object', { cardId: 'c', type: 5 })).toBe('Added an object to c');
  });

  it('does not echo the name of an unknown tool and never reaches inherited properties', () => {
    for (const tool of [
      '',
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty',
      'DROP TABLE',
      'create_card ',
    ]) {
      expect(describeCall(tool, { name: 'x' })).toBe('Ran an unknown tool');
    }
  });

  it('reads own properties only', () => {
    const params = Object.create({ name: 'inherited' }) as Record<string, unknown>;
    expect(describeCall('create_card', params)).toBe('Created a card');
  });

  it('survives an object whose getter throws and a revoked Proxy', () => {
    const getter = {
      get name(): string {
        throw new Error('boom');
      },
    };
    expect(describeCall('create_card', getter)).toBe('Created a card');
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(describeCall('create_card', proxy)).toBe('Created a card');
    expect(
      describeCall(
        'create_card',
        new Proxy(
          {},
          {
            has: () => {
              throw new Error('boom');
            },
            getOwnPropertyDescriptor: () => {
              throw new Error('boom');
            },
          },
        ),
      ),
    ).toBe('Created a card');
  });

  it('is fast for a 1 MB name', () => {
    const start = performance.now();
    const line = describeCall('create_card', { name: 'y'.repeat(1_000_000) });
    expect(performance.now() - start).toBeLessThan(200);
    expect(codePoints(line)).toBeLessThan(80);
  });

  it('is deterministic', () => {
    const params = { name: 'Notes', cardId: 'card-1', type: 'list' };
    expect(describeCall('add_object', params)).toBe(describeCall('add_object', params));
  });

  it('does not change its input', () => {
    const params = { cardId: 'card-1', type: 'button', label: 'Add', nested: { a: [1, 2] } };
    const copy = structuredClone(params);
    describeCall('add_object', params);
    expect(params).toEqual(copy);
  });
});

describe('describeCall: tool argument that is not a string', () => {
  it('returns the unknown-tool line', () => {
    for (const tool of [undefined, null, 5, {}, []]) {
      expect(describeCall(tool as unknown as string, {})).toBe('Ran an unknown tool');
    }
  });
});

describe('describeResult', () => {
  it('describes a rejected call with the first error message', () => {
    expect(
      describeResult({
        tool: 'add_object',
        ok: false,
        errors: [error('x is outside the card'), error('second')],
      }),
    ).toBe('Could not add the object: x is outside the card');
  });

  it('has an action phrase for every tool', () => {
    const expected: Record<(typeof TOOLS)[number], string> = {
      create_card: 'Could not create the card: m',
      delete_card: 'Could not delete the card: m',
      add_object: 'Could not add the object: m',
      update_object: 'Could not change the object: m',
      remove_object: 'Could not remove the object: m',
      link_cards: 'Could not link the cards: m',
      set_action: 'Could not set the action: m',
      say: 'Could not say that: m',
      create_stack: 'Could not name the stack: m',
    };
    for (const tool of TOOLS) {
      expect(describeResult({ tool, ok: false, errors: [error('m')] })).toBe(expected[tool]);
    }
  });

  it('omits the colon when there are no errors or no usable message', () => {
    expect(describeResult({ tool: 'delete_card', ok: false })).toBe('Could not delete the card');
    expect(describeResult({ tool: 'delete_card', ok: false, errors: [] })).toBe(
      'Could not delete the card',
    );
    expect(describeResult({ tool: 'delete_card', ok: false, errors: [error('   ')] })).toBe(
      'Could not delete the card',
    );
  });

  it('describes an accepted step like describeCall without parameters', () => {
    expect(describeResult({ tool: 'create_card', ok: true })).toBe('Created a card');
    expect(describeResult({ tool: 'link_cards', ok: true })).toBe('Linked two cards');
  });

  it('uses the unknown-tool wording for an unknown tool name and does not echo it', () => {
    expect(describeResult({ tool: 'rm -rf', ok: false, errors: [error('m')] })).toBe(
      'Could not run an unknown tool: m',
    );
    expect(describeResult({ tool: 'constructor', ok: false })).toBe(
      'Could not run an unknown tool',
    );
    expect(describeResult({ tool: 'rm -rf', ok: true })).toBe('Ran an unknown tool');
  });

  it('cuts a long message to 200 code points and keeps one line', () => {
    const line = describeResult({
      tool: 'add_object',
      ok: false,
      errors: [error(`first\nline ${LONG}`)],
    });
    expect(line).not.toMatch(/[\n\r]/);
    expect(codePoints(line)).toBeLessThanOrEqual('Could not add the object: '.length + 200);
    expect(line.endsWith('\u2026')).toBe(true);
  });

  it('never throws for malformed steps and errors', () => {
    const malformed: unknown[] = [
      {},
      { tool: 5, ok: false },
      { tool: 'say', ok: false, errors: 'nope' },
      { tool: 'say', ok: false, errors: [null] },
      { tool: 'say', ok: false, errors: [5] },
      { tool: 'say', ok: false, errors: [{ message: 5 }] },
      { tool: 'say', ok: false, errors: [{ message: { a: 1 } }] },
      { tool: 'say', ok: false, errors: { 0: { message: 'x' }, length: 1 } },
      {
        tool: 'say',
        ok: false,
        get errors(): never {
          throw new Error('boom');
        },
      },
    ];
    for (const step of malformed) {
      const line = describeResult(step as Parameters<typeof describeResult>[0]);
      expect(line.length).toBeGreaterThan(0);
      expect(line).not.toMatch(/[\n\r]/);
    }
    expect(() =>
      describeResult(null as unknown as Parameters<typeof describeResult>[0]),
    ).not.toThrow();
  });

  it('does not change its input', () => {
    const step = { tool: 'add_object', ok: false, errors: [error('m')] };
    const copy = structuredClone(step);
    describeResult(step);
    expect(step).toEqual(copy);
  });
});
