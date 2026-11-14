/** Hint_Line text for each Mode. Each names the Alt+M shortcut and the two differ. */
export const INTERACT_HINT =
  'Interact mode. Click buttons, type in fields, follow links. Alt+M switches to Edit mode.';

export const EDIT_HINT =
  'Edit mode. Select an object to inspect it. Escape clears the selection. Alt+M switches to Interact mode.';

export function hintForMode(mode: 'interact' | 'edit'): string {
  return mode === 'interact' ? INTERACT_HINT : EDIT_HINT;
}
