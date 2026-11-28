// Every flag, in every state it can be in: the app must render and each page must open without throwing.
// Built from flags.generated.js, so a new flag is covered the moment you run `npm run flags:sync`.
import { test, expect, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { FLAGS } from '../src/flags.generated.js';
import { FlagsProvider, parseForce } from '../src/flags.jsx';
import App from '../src/App.jsx';

afterEach(cleanup);
const states = (name, f) => (f.variants ? ['off', ...f.variants] : ['on', 'off']).map((s) => `${name}=${s}`);
const cases = [''].concat(Object.entries(FLAGS).flatMap(([n, f]) => states(n, f)));

test.each(cases)('renders every page with %s', (c) => {
  render(<FlagsProvider environmentKey="" force={parseForce(c)}><App /></FlagsProvider>);
  if (c === 'maintenance_mode=on') { expect(screen.getByText(/maintenance/i)).toBeTruthy(); return; }
  for (const page of ['Pricing', 'Checkout', 'Home']) fireEvent.click(screen.getByText(page));
  expect(screen.getByRole('heading')).toBeTruthy();
});

test('compact layout preview reaches the page', () => {
  render(<FlagsProvider environmentKey="" force={parseForce('pricing_layout=compact')}><App /></FlagsProvider>);
  fireEvent.click(screen.getByText('Pricing'));
  expect(screen.getByTestId('plans').dataset.layout).toBe('compact');
});
