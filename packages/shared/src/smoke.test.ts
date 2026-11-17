import { describe, expect, it } from 'vitest';
import * as root from './index.ts';
import * as format from './format/index.ts';
import * as engine from './engine/index.ts';
import * as aiWire from './ai-wire/index.ts';

describe('shared package entry points', () => {
  it('loads the root entry module with no exports yet', () => {
    expect(typeof root).toBe('object');
    expect(Object.keys(root)).toEqual([]);
  });

  it('exports exactly the public engine API', () => {
    expect(Object.keys(engine).sort()).toEqual([
      'OPERATIONS',
      'OPERATION_NAMES',
      'applyOperation',
      'buildRenderModel',
      'createStack',
      'executeHandler',
      'operationJsonSchema',
      'remixStack',
    ]);
  });

  it('exports exactly the public ai-wire API', () => {
    expect(Object.keys(aiWire).sort()).toEqual([
      'AI_WIRE_LIMITS',
      'ChatRequestSchema',
      'PublicReplySchema',
      'UpstreamReplySchema',
    ]);
  });

  it('exports exactly the public format API', () => {
    expect(Object.keys(format).sort()).toEqual(
      [
        'ACTION_TYPES',
        'ENTITY_ID_PATTERN',
        'FORMAT_VERSION',
        'IMAGE_SRC_PATTERN',
        'LIMITS',
        'OBJECT_TYPES',
        'VALIDATION_ERROR_CODES',
        'ActionSchema',
        'AiFieldSchema',
        'AppendItemActionSchema',
        'ButtonSchema',
        'CardSchema',
        'FetchNewsActionSchema',
        'FieldSchema',
        'GoToCardActionSchema',
        'HandlerSchema',
        'ImageSchema',
        'LinkSchema',
        'ListSchema',
        'ObjectSchema',
        'RemoveItemActionSchema',
        'RunAiFieldActionSchema',
        'ScheduleNotificationActionSchema',
        'SetValueActionSchema',
        'ShowMessageActionSchema',
        'StackSchema',
        'TranscribeAudioActionSchema',
        'parseStack',
        'serializeStack',
        'stackJsonSchema',
        'validateHandler',
        'validateStack',
        'checkAgainstSchema',
        'createValidationError',
        'toJsonPointer',
      ].sort(),
    );
  });
});
