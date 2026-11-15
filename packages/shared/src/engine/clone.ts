/**
 * Structural copy of plain JSON data.
 *
 * `structuredClone` is not part of the ES2022 lib the shared package compiles
 * against, and the engine must not depend on environment APIs, so this is a
 * small recursive copy. Input is trusted to be acyclic JSON (a validated Stack,
 * a Handler, a render model); a cyclic value overflows the call stack.
 */

/** Copies one value; arrays and plain objects are rebuilt, everything else is returned as is. */
function copyValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) {
      items.push(copyValue(item));
    }
    return items;
  }
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      // defineProperty keeps an own "__proto__" key as data instead of
      // letting plain assignment replace the prototype of the copy.
      Object.defineProperty(copy, key, {
        value: copyValue(source[key]),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return copy;
  }
  // string, number, boolean, null (and undefined) are immutable values.
  return value;
}

/**
 * Returns a deep copy of plain JSON data (objects, arrays, strings, numbers,
 * booleans, `null`). Key order is preserved. The copy shares no object or
 * array with the input and is never frozen, even when the input is.
 */
export function deepCopyJson<T>(value: T): T {
  return copyValue(value) as T;
}
