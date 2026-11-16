/** How long the object URL stays valid after the click. Revoking at once can cancel a download. */
const REVOKE_AFTER_MS = 1000;

/**
 * Offers `text` to the user as a file download: a `Blob`, an object URL, and a temporary
 * anchor that is clicked and removed. The only DOM download code in the app.
 */
export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.hidden = true;
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
  }
}
