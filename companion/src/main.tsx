import React from 'react';
import ReactDOM from 'react-dom/client';
import { initializeDiagnostics } from './lib/diagnostics';
const Surface = React.lazy(() => location.hash === '#diagnostics' ? import('./Diagnostics') : import('./App'));
initializeDiagnostics();
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><React.Suspense fallback={<p>正在加载…</p>}><Surface /></React.Suspense></React.StrictMode>);
