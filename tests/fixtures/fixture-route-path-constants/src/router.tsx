import { createBrowserRouter } from 'react-router-dom';
import { ROOT_PATH, ROUTER_PATHS } from './router-paths';
import { Home } from './pages/Home';
import { Dashboard } from './pages/Dashboard';
import { Payment } from './pages/Payment';
import { Confirm } from './pages/Confirm';

// Three path-constant forms PF2.4 must handle:
//   1. Direct identifier:   ROOT_PATH
//   2. Single-level member: ROUTER_PATHS.dashboard
//   3. Nested member:       ROUTER_PATHS.checkout.payment
export const router = createBrowserRouter([
  { path: ROOT_PATH, element: <Home /> },
  { path: ROUTER_PATHS.dashboard, element: <Dashboard /> },
  { path: ROUTER_PATHS.checkout.payment, element: <Payment /> },
  { path: ROUTER_PATHS.checkout.confirm, element: <Confirm /> },
]);
