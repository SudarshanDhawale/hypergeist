import { describe, expect, it } from 'vitest';
import { SCENARIO_LIMITS, ScenarioSchema, loadScenarios, normalizePrompt } from './scenario-set.ts';

/** A valid scenario object; `over` replaces fields. */
function scenario(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sample',
    title: 'Sample',
    prompts: ['Do the sample'],
    mode: 'edit',
    replies: [{ content: 'Done.' }],
    ...over,
  };
}

function file(over: Record<string, unknown> = {}): string {
  return JSON.stringify(scenario(over));
}

describe('normalizePrompt', () => {
  it('trims, lower-cases, collapses white space and strips trailing . ! ?', () => {
    expect(normalizePrompt('  Make   Me\ta \n To-Do  List?!. ')).toBe('make me a to-do list');
  });

  it('keeps punctuation inside the text', () => {
    expect(normalizePrompt('Add a to-do, then a note.')).toBe('add a to-do, then a note');
  });

  it('is idempotent and gives an empty string for white space and end punctuation only', () => {
    const once = normalizePrompt(' Hello   World!! ');
    expect(normalizePrompt(once)).toBe(once);
    expect(normalizePrompt(' ?! ')).toBe('');
  });
});

describe('ScenarioSchema', () => {
  it('accepts every mode, including text', () => {
    for (const mode of ['new-stack', 'edit', 'text']) {
      expect(ScenarioSchema.safeParse(scenario({ mode })).success).toBe(true);
    }
  });

  it('accepts tool calls with nested JSON arguments', () => {
    const replies = [{ toolCalls: [{ name: 'set_action', arguments: { a: [1, { b: null }] } }] }];
    expect(ScenarioSchema.safeParse(scenario({ replies })).success).toBe(true);
  });

  it('rejects unknown properties at every level', () => {
    expect(ScenarioSchema.safeParse(scenario({ extra: 1 })).success).toBe(false);
    expect(
      ScenarioSchema.safeParse(scenario({ replies: [{ content: 'x', extra: 1 }] })).success,
    ).toBe(false);
    const call = { name: 'say', arguments: {}, extra: 1 };
    expect(ScenarioSchema.safeParse(scenario({ replies: [{ toolCalls: [call] }] })).success).toBe(
      false,
    );
  });

  it('rejects an unknown mode, a bad id and a missing title', () => {
    expect(ScenarioSchema.safeParse(scenario({ mode: 'chat' })).success).toBe(false);
    expect(ScenarioSchema.safeParse(scenario({ id: 'Bad Id' })).success).toBe(false);
    expect(ScenarioSchema.safeParse(scenario({ title: '' })).success).toBe(false);
  });

  it('holds the prompt limits: 1 to 10 prompts of 1 to 200 characters', () => {
    expect(ScenarioSchema.safeParse(scenario({ prompts: [] })).success).toBe(false);
    const ten = Array.from({ length: 10 }, (_, i) => `prompt ${i}`);
    expect(ScenarioSchema.safeParse(scenario({ prompts: ten })).success).toBe(true);
    expect(ScenarioSchema.safeParse(scenario({ prompts: [...ten, 'one more'] })).success).toBe(
      false,
    );
    expect(ScenarioSchema.safeParse(scenario({ prompts: [''] })).success).toBe(false);
    expect(ScenarioSchema.safeParse(scenario({ prompts: ['a'.repeat(200)] })).success).toBe(true);
    expect(ScenarioSchema.safeParse(scenario({ prompts: ['a'.repeat(201)] })).success).toBe(false);
  });

  it('rejects a prompt that is empty after normalization', () => {
    expect(ScenarioSchema.safeParse(scenario({ prompts: ['  ?! '] })).success).toBe(false);
  });

  it('holds the reply limits: 1 to 12 replies', () => {
    expect(ScenarioSchema.safeParse(scenario({ replies: [] })).success).toBe(false);
    const twelve = Array.from({ length: SCENARIO_LIMITS.replies.max }, () => ({ content: 'x' }));
    expect(ScenarioSchema.safeParse(scenario({ replies: twelve })).success).toBe(true);
    expect(
      ScenarioSchema.safeParse(scenario({ replies: [...twelve, { content: 'y' }] })).success,
    ).toBe(false);
  });

  it('rejects arguments that are not an object', () => {
    const replies = [{ toolCalls: [{ name: 'say', arguments: 'text' }] }];
    expect(ScenarioSchema.safeParse(scenario({ replies })).success).toBe(false);
  });
});

describe('loadScenarios with the bundled files', () => {
  const set = loadScenarios();

  it('has no problems', () => {
    expect(set.problems).toEqual([]);
  });

  it('ships the scenarios of this spec, in file name order', () => {
    expect(set.scenarios.map((s) => s.id)).toEqual([
      'add-a-button',
      'smart-todo-when-guess',
      'study-deck-flashcards',
      'study-deck-quiz',
      'study-deck-walkthrough',
      'summarize-text',
      'todo-from-a-sentence',
    ]);
    expect(set.scenarios.map((s) => s.mode)).toEqual([
      'edit',
      'text',
      'text',
      'text',
      'text',
      'text',
      'new-stack',
    ]);
  });

  it('has unique ids and unique normalized prompts', () => {
    const ids = set.scenarios.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const prompts = set.scenarios.flatMap((s) => s.prompts.map(normalizePrompt));
    expect(new Set(prompts).size).toBe(prompts.length);
  });
});

describe('loadScenarios with injected files', () => {
  it('returns scenarios in file name order, whatever the key order', () => {
    const set = loadScenarios({
      './b.json': file({ id: 'b', prompts: ['bee'] }),
      './a.json': file({ id: 'a', prompts: ['ay'] }),
    });
    expect(set.scenarios.map((s) => s.id)).toEqual(['a', 'b']);
    expect(set.problems).toEqual([]);
  });

  it('reports invalid JSON and keeps the other files', () => {
    const set = loadScenarios({ './bad.json': '{ not json', './ok.json': file() });
    expect(set.scenarios.map((s) => s.id)).toEqual(['sample']);
    expect(set.problems).toEqual([{ file: './bad.json', message: 'The file is not valid JSON.' }]);
  });

  it('reports a schema failure with the path of the problem', () => {
    const set = loadScenarios({ './x.json': file({ mode: 'chat' }) });
    expect(set.scenarios).toEqual([]);
    expect(set.problems).toHaveLength(1);
    expect(set.problems[0]?.file).toBe('./x.json');
    expect(set.problems[0]?.message).toContain('/mode');
  });

  it('reports a duplicate scenario id and keeps the first', () => {
    const set = loadScenarios({
      './a.json': file({ prompts: ['one'] }),
      './b.json': file({ prompts: ['two'] }),
    });
    expect(set.scenarios).toHaveLength(1);
    expect(set.problems).toHaveLength(1);
    expect(set.problems[0]?.file).toBe('./b.json');
    expect(set.problems[0]?.message).toContain('"sample"');
  });

  it('reports a normalized prompt shared by two scenarios and skips the later one', () => {
    const set = loadScenarios({
      './a.json': file({ id: 'a', prompts: ['Make a list!'] }),
      './b.json': file({ id: 'b', prompts: ['other', '  make   A LIST. '] }),
    });
    expect(set.scenarios.map((s) => s.id)).toEqual(['a']);
    expect(set.problems).toHaveLength(1);
    expect(set.problems[0]?.file).toBe('./b.json');
    expect(set.problems[0]?.message).toContain('make a list');
  });

  it('does not throw for a non-object JSON value or an empty file set', () => {
    expect(loadScenarios({ './n.json': 'null', './s.json': '"text"' }).problems).toHaveLength(2);
    expect(loadScenarios({})).toEqual({ scenarios: [], problems: [] });
  });

  it('does not modify its input', () => {
    const files = Object.freeze({ './a.json': file() });
    expect(() => loadScenarios(files)).not.toThrow();
  });
});
