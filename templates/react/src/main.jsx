import React from 'react';
import { createRoot } from 'react-dom/client';
import { FlagsProvider } from './flags.jsx';
import App from './App.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <FlagsProvider>
      <App />
    </FlagsProvider>
  </React.StrictMode>,
);
