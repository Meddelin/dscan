import { createBrowserRouter } from 'react-router-dom';
import { AbilityGuard } from '@casl/react'; // external
import { ErrorBoundary } from '@sentry/react'; // external
import * as Pages from './pages';
import { Layout } from './shared/Layout';
import { Page as PlainPage } from './pages/PlainPage';

// PF2.5 — wrapper depth ≤ 5 with mixed external wrappers and local
// page candidates (both plain and member-expression).
export const router = createBrowserRouter([
  {
    // Depth 3: ErrorBoundary > AbilityGuard > <Layout><Pages.BuildInfra/></Layout>
    path: '/builds',
    element: (
      <ErrorBoundary fallback={null}>
        <AbilityGuard action="view" subject="build">
          <Layout>
            <Pages.BuildInfra />
          </Layout>
        </AbilityGuard>
      </ErrorBoundary>
    ),
  },
  {
    // Plain wrapper + plain local child.
    path: '/plain',
    element: (
      <AbilityGuard action="view" subject="plain">
        <PlainPage />
      </AbilityGuard>
    ),
  },
]);
