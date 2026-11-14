import { describe, expect, it } from 'vitest';
import * as root from './index.ts';
import * as format from './format/index.ts';
import * as engine from './engine/index.ts';

describe('shared package entry points', () => {
  it('loads the root entry module with no exports yet', () => {
    expect(typeof root).toBe('object');
    expect(Object.keys(root)).toEqual([]);
  });

  it('exports exactly the public engine API', () => {
    expect(Object.keys(engine).sort()).toEqual(['executeHandler']);
  });

  it('exports exactly the public format API', () => {
    expect(Object.keys(format).sort()).toEqual(
      [
        'ENTITY_ID_PATTERN',
        'FORMAT_VERSION',
        'LIMITS',
        'SUPPORTED_ACTION_TYPES',
        'SUPPORTED_OBJECT_TYPES',
        'UNSUPPORTED_ACTION_TYPES',
        'UNSUPPORTED_OBJECT_TYPES',
        'VALIDATION_ERROR_CODES',
        'ActionSchema',
        'AppendItemActionSchema',
        'ButtonSchema',
        'CardSchema',
        'FieldSchema',
        'GoToCardActionSchema',
        'HandlerSchema',
        'LinkSchema',
        'ListSchema',
        'ObjectSchema',
        'SetValueActionSchema',
        'ShowMessageActionSchema',
        'StackSchema',
        'validateHandler',
        'validateStack',
      ].sort(),
    );
  });
});
