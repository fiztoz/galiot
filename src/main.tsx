import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { BRAND } from './branding';
import './app.css';
document.title = BRAND.title;

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Failed to find the root element');
}

function CrashScreen({ message }: { message: string }) {
  return (
    <div role="alert" className="min-h-screen flex items-center justify-center p-6 bg-zinc-50 dark:bg-zinc-950">
      <div className="max-w-md text-center space-y-3">
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">{BRAND.name} hit an unexpected error.</p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 break-words">{message}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="px-3 py-1.5 text-xs font-medium rounded-lg bg-teal-600 hover:bg-teal-700 text-white"
        >
          Reload
        </button>
      </div>
    </div>
  );
}

// React unmounts the whole tree on an uncaught render error. Without a class
// error boundary (functional components only), show a way back instead of a
// blank page. The vault stays sealed; reloading only asks to unlock again.
const root = createRoot(rootElement, {
  onUncaughtError(error) {
    console.error(error);
    const message = error instanceof Error ? error.message : String(error);
    queueMicrotask(() => root.render(<CrashScreen message={message} />));
  },
});
root.render(
  <StrictMode>
    <App />
  </StrictMode>
);

// App-shell caching only in production builds; dev relies on Vite HMR.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((error) => {
      console.error('Service Worker registration failed:', error);
    });
  });
}
