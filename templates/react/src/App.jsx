// Four flag patterns you will use in every product:
//   maintenance_mode  kill switch: one toggle swaps the whole app for a maintenance screen
//   checkout_v2       release toggle: ship the new checkout dark, turn it on per environment or segment
//   welcome_message   remote config: change copy without a deploy
//   pricing_layout    experiment: control vs compact, with the exposure and the conversion recorded
import React, { useState } from 'react';
import { useFlag, useVariant, useTrack, useFlagSource } from './flags.jsx';

function Pricing() {
  const layout = useVariant('pricing_layout');
  const track = useTrack();
  const [chosen, setChosen] = useState(null);
  if (chosen) return <p>Thanks for choosing {chosen}.</p>;
  return (
    <div className={`plans ${layout === 'compact' ? 'compact' : ''}`} data-testid="plans" data-layout={layout}>
      {[['Free', '$0'], ['Pro', '$12'], ['Team', '$40']].map(([n, p]) => (
        <div className="plan" key={n}>
          <b>{n}</b> {p}/mo{' '}
          <button onClick={() => { track('upgrade_click'); setChosen(n); }}>Choose {n}</button>
        </div>
      ))}
    </div>
  );
}

function Checkout() {
  const v2 = useFlag('checkout_v2').enabled;
  return v2 ? <p>One-page checkout, Apple Pay first.</p> : <p>Step 1 of 3: your details.</p>;
}

export default function App() {
  const maintenance = useFlag('maintenance_mode').enabled;
  const welcome = useFlag('welcome_message').value;
  const source = useFlagSource();
  const [page, setPage] = useState('home');
  if (maintenance) return <main><h1>Back in a few minutes</h1><p>We are doing some maintenance.</p></main>;
  return (
    <main>
      <h1>{welcome || 'Welcome!'}</h1>
      <nav>
        <button onClick={() => setPage('home')}>Home</button>{' '}
        <button onClick={() => setPage('pricing')}>Pricing</button>{' '}
        <button onClick={() => setPage('checkout')}>Checkout</button>
      </nav>
      {page === 'pricing' && <Pricing />}
      {page === 'checkout' && <Checkout />}
      <p><small>flags: {source} · preview any variant with ?flags=pricing_layout=compact</small></p>
    </main>
  );
}
