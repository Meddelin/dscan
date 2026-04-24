import type { ReactNode } from 'react';

export function Modal({ children }: { children: ReactNode }) {
  return (
    <div className="modal-backdrop">
      <div className="modal-body">
        <button className="modal-close">×</button>
        <div className="modal-content">{children}</div>
      </div>
    </div>
  );
}
