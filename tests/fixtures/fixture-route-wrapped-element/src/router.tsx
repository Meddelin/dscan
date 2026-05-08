import { createBrowserRouter } from 'react-router-dom';
import { AbilityGuard } from '@casl/react'; // external — not in repo
import { CreateProject } from './pages/CreateProject';
import { Settings } from './pages/Settings';

// External wrapper around a local page. Scanner must look past AbilityGuard
// (which doesn't resolve in-repo) and bind the route to CreateProject.
export const router = createBrowserRouter([
  {
    path: '/projects/new',
    element: (
      <AbilityGuard action="create" subject="allure-project">
        <CreateProject />
      </AbilityGuard>
    ),
  },
  { path: '/settings', element: <Settings /> },
]);
