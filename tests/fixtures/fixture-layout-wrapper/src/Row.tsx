import type { ReactNode } from 'react';
import { Button } from '@beaver-ui/button';

// Layout-wrapper around Beaver: no className on Beaver, markup 3 elements
// (< substantialMarkupElements). Should land as adoption-wrapper (§3.6).
export function Row({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div>
      <Button>{left}</Button>
      <Button>{right}</Button>
    </div>
  );
}
