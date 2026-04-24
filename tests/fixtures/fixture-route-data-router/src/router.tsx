import { createBrowserRouter } from 'react-router-dom';
import { Dashboard } from './pages/Dashboard';
import { Settings } from './pages/Settings';

export const router = createBrowserRouter([
  { path: '/dashboard', element: <Dashboard /> },
  { path: '/settings', element: <Settings /> },
]);
