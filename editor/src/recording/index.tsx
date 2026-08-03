// Entry point of the built-in recording view -- the focused slice of IQEngine
// (github.com/iqengine/iqengine) that this repo vendors under src/recording/.
// It is the editor's *second* Vite entry, emitted at /recording/, and the editor
// frames one <iframe> on it per File Source (see recordingViewUrl() in main.ts).
//
// Upstream's index.tsx wires up MSAL auth, Google Analytics, feature flags and a
// router covering the browser/admin/docs/converter/siggen pages. None of those
// come along: there is no backend and no account here, and the only route that
// exists is the recording view itself, reached through the 'url' data source.
import { createRoot } from 'react-dom/client';
import { createHashRouter, RouterProvider } from 'react-router-dom';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import { Toaster } from 'react-hot-toast';
import { RecordingViewPage } from '@/pages/recording-view/recording-view';
// Upstream loads a per-theme stylesheet lazily behind a <ThemeSelector>; this
// port has exactly one theme (the editor's, see tailwind.config.cjs), so the
// two are plain imports.
import '@/features/ui/styles/tailwind_index.css';
import '@/features/ui/styles/index.css';

const container = document.getElementById('root');
if (!container) throw new Error('No root element found');
const root = createRoot(container);

// React Query stuff (same defaults upstream sets for the queries that survive)
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
    },
  },
});
queryClient.setQueryDefaults(['rawiqdata'], { staleTime: Infinity });
queryClient.setQueryDefaults(['iqData'], { staleTime: 5, cacheTime: 10 });

// Hash routing, so the page is a plain directory of static files: the route
// lives after the '#' and never reaches the server, which matters because the
// COOP/COEP dev server and Cloudflare Pages both serve this as static files with
// no SPA rewrite. Same reason upstream offers IQENGINE_HASH_ROUTER.
const router = createHashRouter([
  {
    path: '/view/:type/:account/:container/:filePath',
    element: <RecordingViewPage />,
  },
  {
    path: '*',
    element: <div className="p-4">No recording selected.</div>,
  },
]);

root.render(
  <QueryClientProvider client={queryClient}>
    <Toaster />
    <RouterProvider router={router} />
  </QueryClientProvider>
);
