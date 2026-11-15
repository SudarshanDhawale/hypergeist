import { describe, expect, it } from 'vitest';
import { VALIDATION_ERROR_CODES } from './errors.ts';
import {
  ACTION_TYPES,
  ENTITY_ID_PATTERN,
  FORMAT_VERSION,
  IMAGE_SRC_PATTERN,
  LIMITS,
  OBJECT_TYPES,
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
      imageAlt: { min: 0, max: 200 },
      imageHttpsSrc: { min: 1, max: 2000 },
      imageDataSrc: { min: 1, max: 1_000_000 },
      aiPrompt: { min: 1, max: 2000 },
      aiInputObjects: { min: 0, max: 10 },
      aiFieldValue: { min: 0, max: 10_000 },
      removeItemIndex: { min: 0 },
      newsTopics: { min: 1, max: 10 },
      newsTopicText: { min: 1, max: 100 },
      notificationMessage: { min: 1, max: 500 },
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
  it('pins the Object types in the order of the requirements', () => {
    expect([...OBJECT_TYPES]).toEqual(['button', 'field', 'image', 'list', 'ai-field']);
  });

  it('pins the nine Action types in glossary order', () => {
    expect([...ACTION_TYPES]).toEqual([
      'go_to_card',
      'set_value',
      'append_item',
      'remove_item',
      'show_message',
      'run_ai_field',
      'fetch_news',
      'transcribe_audio',
      'schedule_notification',
    ]);
  });
});

describe('IMAGE_SRC_PATTERN', () => {
  const png = 'iVBORw0KGgo=';

  it('has no flags and is ASCII only', () => {
    expect(IMAGE_SRC_PATTERN.flags).toBe('');
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7F]*$/.test(IMAGE_SRC_PATTERN.source)).toBe(true);
  });

  it.each([
    'https://example.com',
    'https://example.com/a/b.png?x=1#frag',
    'https://[::1]:8080/x',
    'https://a-b.example.com:443/%20x',
    `data:image/png;base64,${png}`,
    'data:image/jpeg;base64,AAAA',
    'data:image/gif;base64,AAA=',
    'data:image/webp;base64,AA==',
  ])('accepts %s', (src) => {
    expect(IMAGE_SRC_PATTERN.test(src)).toBe(true);
  });

  it.each([
    '',
    'http://example.com',
    'HTTPS://example.com',
    'https://',
    'https:///path',
    'https://user@example.com',
    'https://example.com/a b',
    'https://example.com/a\\b',
    'https://example.com/é',
    'https://example.com/\n',
    'https://example.com\n',
    'data:image/svg+xml;base64,AAAA',
    'data:image/png;base64,',
    'data:image/png;base64,AAA',
    'data:image/png;base64,AA=A',
    'data:image/png;base64,AAAA=',
    'data:image/png,AAAA',
    'data:text/html;base64,AAAA',
    'javascript:alert(1)',
  ])('rejects %j', (src) => {
    expect(IMAGE_SRC_PATTERN.test(src)).toBe(false);
  });

  it('handles a 1,000,000-character data URI without failing', () => {
    const payload = 'A'.repeat(999_988 - (999_988 % 4));
    const uri = `data:image/png;base64,${payload}`;
    expect(IMAGE_SRC_PATTERN.test(uri)).toBe(true);
    expect(IMAGE_SRC_PATTERN.test(`${uri}!`)).toBe(false);
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
