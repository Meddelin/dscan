import type { ReactNode } from 'react';
// Local layout — Pass-B classifier would call this neither/layout-wrapper
// because of the name. Important: it's in-repo, but the inner BuildInfra
// is the real page component the route should bind to.
export function Layout({ children }: { children: ReactNode }) {
  return <div className="layout">{children}</div>;
}
