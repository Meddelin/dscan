import type { ReactNode } from 'react';

export function LocalPanel({ children }: { children: ReactNode }) {
  return <div className="panel">{children}</div>;
}
