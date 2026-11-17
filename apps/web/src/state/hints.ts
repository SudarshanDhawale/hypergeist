import type { Mode } from './stack-store.ts';

/** Hint_Line text for each Mode. Each names the Alt+M shortcut and they all differ. */
export const INTERACT_HINT =
  'Interact mode. Click buttons, type in fields, follow links. Alt+M switches to Edit mode.';

export const EDIT_HINT =
  'Edit mode. Select an object to inspect it. Escape clears the selection. Alt+M switches to AI edit mode.';

export const AI_EDIT_HINT =
  'AI edit mode. Click an object, then tell the Ghost what to change. Alt+M switches mode.';

export function hintForMode(mode: Mode): string {
  switch (mode) {
    case 'interact':
      return INTERACT_HINT;
    case 'edit':
      return EDIT_HINT;
    case 'ai-edit':
      return AI_EDIT_HINT;
  }
}
