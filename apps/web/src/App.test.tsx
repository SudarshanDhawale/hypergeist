import { render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { App } from './App';

it('renders the HyperGeist heading', () => {
  const { getByRole } = render(<App />);
  expect(getByRole('heading', { name: 'HyperGeist' })).toBeTruthy();
});
