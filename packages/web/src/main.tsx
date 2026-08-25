import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './index.css';
import '@xyflow/react/dist/style.css';

const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing from index.html');
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
