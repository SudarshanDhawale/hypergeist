import type { JSX } from 'react';
import type { ValidationError } from '@hypergeist/shared/format';

/**
 * Shown instead of the Stack_Window when the bundled Stack fails validation.
 * Keeps the page heading and lists each structured error in plain language.
 */
export function LoadErrorScreen({
  errors,
}: {
  readonly errors: readonly ValidationError[];
}): JSX.Element {
  return (
    <>
      <header className="menu-bar" aria-label="Menu bar">
        <h1>HyperGeist</h1>
      </header>
      <main>
        <div className="load-error" role="alert">
          <h2>This stack could not be opened</h2>
          <p>
            The stack that came with the app did not pass its checks, so nothing is shown. Each
            problem is listed below.
          </p>
          <ul>
            {errors.map((error, index) => (
              <li key={`${error.code}:${error.path}:${index}`}>
                <p>
                  <code>{error.code}</code> at{' '}
                  <code>{error.path === '' ? '(root)' : error.path}</code>
                </p>
                <p>{error.message}</p>
                <p>How to fix it: {error.hint}</p>
              </li>
            ))}
          </ul>
        </div>
      </main>
    </>
  );
}
