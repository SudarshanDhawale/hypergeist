/**
 * Helpers for purity tests: freeze an input so a write throws in strict mode,
 * and copy it beforehand so the test can compare before and after.
 */

/** Freezes `value` and everything reachable from it, and returns the same value. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

/**
 * Plain recursive copy of JSON-like data (objects, arrays, primitives).
 * The copy shares no object or array with the input and is never frozen.
 */
export function deepCopy<T>(value: T): T {
  return copyValue(value) as T;
}

function copyValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(copyValue);
  }
  if (typeof value === 'object' && value !== null) {
    const copy: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      // defineProperty keeps an own "__proto__" key as data instead of setting the prototype.
      Object.defineProperty(copy, key, {
        value: copyValue(child),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return copy;
  }
  return value;
}
