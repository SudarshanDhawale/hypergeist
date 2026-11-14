import { render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { LoadErrorScreen } from './LoadErrorScreen.tsx';

it('lists code, path, message and hint, and keeps the single heading', () => {
  const { getByRole, getAllByRole, container } = render(
    <LoadErrorScreen
      errors={[
        {
          code: 'INVALID_VALUE',
          path: '/cards/0/name',
          message: 'Name is empty.',
          expected: 'non-empty text',
          actual: '',
          hint: 'Give the card a name.',
        },
      ]}
    />,
  );
  expect(getAllByRole('heading', { level: 1, name: 'HyperGeist' })).toHaveLength(1);
  const alert = getByRole('alert');
  expect(alert.classList.contains('load-error')).toBe(true);
  expect(alert.textContent).toContain('INVALID_VALUE');
  expect(alert.textContent).toContain('/cards/0/name');
  expect(alert.textContent).toContain('Name is empty.');
  expect(alert.textContent).toContain('Give the card a name.');
  expect(container.querySelector('.stack-window')).toBeNull();
});
