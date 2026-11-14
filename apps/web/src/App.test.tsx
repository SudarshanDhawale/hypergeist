import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { App } from './App.tsx';

afterEach(cleanup);

it('renders the HyperGeist heading exactly once', () => {
  const { getAllByRole } = render(<App />);
  expect(getAllByRole('heading', { name: 'HyperGeist' })).toHaveLength(1);
});

it('shows the error screen and keeps the heading for invalid stack text', () => {
  const { getAllByRole, getByRole } = render(<App stackText="not json" />);
  expect(getAllByRole('heading', { name: 'HyperGeist' })).toHaveLength(1);
  expect(getByRole('alert').textContent).toContain('INVALID_JSON');
});
