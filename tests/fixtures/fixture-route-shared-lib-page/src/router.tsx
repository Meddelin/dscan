import { createBrowserRouter } from 'react-router-dom';
// Both routes pull pages through a barrel index (`page-kit`). PF2.6 chain
// follower must drill in to bind each route to the page's defining file,
// not the barrel.
import { SharedDashboard, SharedSettings } from './page-kit';

export const router = createBrowserRouter([
  { path: '/dashboard', element: <SharedDashboard /> },
  { path: '/settings', element: <SharedSettings /> },
]);
