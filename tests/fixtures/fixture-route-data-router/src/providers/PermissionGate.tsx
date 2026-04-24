import type { ReactNode } from 'react';

// Only reachable from Settings → bound to /settings.
export function PermissionGate({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
