import { describe, expect, it } from 'vitest';
import { VALIDATION_ERROR_CODES } from './errors.ts';
import {
  ENTITY_ID_PATTERN,
  FORMAT_VERSION,
  LIMITS,
  SUPPORTED_ACTION_TYPES,
  SUPPORTED_OBJECT_TYPES,
  UNSUPPORTED_ACTION_TYPES,
  UNSUPPORTED_OBJECT_TYPES,
} from './limits.ts';

describe('LIMITS', () => {
  it('pins every bound to the value in the requirements', () => {
    expect(LIMITS).toEqual({
      stackName: { min: 1, max: 100 },
      cardSize: { min: 64, max: 4096 },
      cards: { min: 1, max: 200 },
      cardName: { min: 1, max: 100 },
      objectsPerCard: { min: 0, max: 100 },
      linksPerCard: { min: 0, max: 50 },
      linkLabel: { min: 1, max: 100 },
      objectName: { min: 0, max: 100 },
      objectPosition: { min: 0, max: 4096 },
      objectSize: { min: 8, max: 4096 },
      buttonLabel: { min: 1, max: 100 },
      fieldValue: { min: 0, max: 10_000 },
      fieldPlaceholder: { min: 0, max: 200 },
      listItems: { min: 0, max: 500 },
      listItemText: { min: 0, max: 500 },
      handlerActions: { min: 0, max: 20 },
      setValueText: { min: 0, max: 10_000 },
      appendItemText: { min: 0, max: 500 },
      messageText: { min: 1, max: 500 },
      maxDocumentBytes: 2_097_152,
      maxErrors: 100,
      actualMaxChars: 200,
    });
  });

  it('uses 2 MiB as the document size limit', () => {
    expect(LIMITS.maxDocumentBytes).toBe(2 * 1024 * 1024);
  });
});

describe('FORMAT_VERSION', () => {
  it('is 1', () => {
    expect(FORMAT_VERSION).toBe(1);
  });
});

describe('ENTITY_ID_PATTERN', () => {
  it('has the exact source from the requirements', () => {
    expect(ENTITY_ID_PATTERN.source).toBe('^[a-z0-9][a-z0-9_-]{0,63}$');
    expect(ENTITY_ID_PATTERN.flags).toBe('');
  });

  it.each(['a', '0', 'todo-add', 'a_b-c', 'a'.repeat(64)])('accepts %s', (id) => {
    expect(ENTITY_ID_PATTERN.test(id)).toBe(true);
  });

  it.each(['', '-a', '_a', 'A', 'a b', 'a.b', 'é', 'a'.repeat(65), 'a\n'])('rejects %j', (id) => {
    expect(ENTITY_ID_PATTERN.test(id)).toBe(false);
  });
});

describe('type lists', () => {
  it('pins the supported and unsupported Object types', () => {
    expect([...SUPPORTED_OBJECT_TYPES]).toEqual(['button', 'field', 'list']);
    expect([...UNSUPPORTED_OBJECT_TYPES]).toEqual(['image', 'ai-field']);
  });

  it('pins the supported and unsupported Action types', () => {
    expect([...SUPPORTED_ACTION_TYPES]).toEqual([
      'go_to_card',
      'set_value',
      'append_item',
      'show_message',
    ]);
    expect([...UNSUPPORTED_ACTION_TYPES]).toEqual([
      'remove_item',
      'run_ai_field',
      'fetch_news',
      'transcribe_audio',
      'schedule_notification',
    ]);
  });

  it('keeps supported and unsupported lists disjoint', () => {
    const objectTypes: readonly string[] = SUPPORTED_OBJECT_TYPES;
    const actionTypes: readonly string[] = SUPPORTED_ACTION_TYPES;
    expect(UNSUPPORTED_OBJECT_TYPES.some((t) => objectTypes.includes(t))).toBe(false);
    expect(UNSUPPORTED_ACTION_TYPES.some((t) => actionTypes.includes(t))).toBe(false);
  });
});

describe('VALIDATION_ERROR_CODES', () => {
  it('is the closed set of 14 codes, in the order of the full spec', () => {
    expect([...VALIDATION_ERROR_CODES]).toEqual([
      'INVALID_JSON',
      'MISSING_PROPERTY',
      'UNKNOWN_PROPERTY',
      'WRONG_TYPE',
      'INVALID_VALUE',
      'OUT_OF_RANGE',
      'DUPLICATE_ID',
      'DANGLING_REFERENCE',
      'WRONG_REFERENCE_TYPE',
      'OUT_OF_BOUNDS',
      'LIMIT_EXCEEDED',
      'UNSUPPORTED_VERSION',
      'DUPLICATE_LINK',
      'UNKNOWN_ENTITY',
    ]);
    expect(new Set(VALIDATION_ERROR_CODES).size).toBe(14);
  });
});
