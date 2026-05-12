import { createBrowserRouter } from 'react-router-dom';
import * as Pages from './pages';
import { Routes as RoutesObj } from './page-registry';

// Two patterns the scanner must support:
//   - `<Pages.X/>` via namespace import
//   - `<RoutesObj.X/>` via named import of an object
export const router = createBrowserRouter([
  { path: '/dashboard', element: <Pages.Dashboard /> },
  { path: '/builds', element: <Pages.MobileBuilds /> },
  { path: '/settings', element: <RoutesObj.Settings /> },
]);
