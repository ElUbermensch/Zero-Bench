import { createRoot } from 'react-dom/client';
import App from './Zero.jsx';

/* window.storage shim matching Zero's PWA build: async KV over localStorage */
window.storage = {
  async get(k) { const v = localStorage.getItem('zs_' + k); return v == null ? null : { value: v }; },
  async set(k, v) { localStorage.setItem('zs_' + k, v); return true; },
};
createRoot(document.getElementById('root')).render(<App/>);
