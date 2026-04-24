import type { ReactNode } from 'react';

interface ButtonProps {
  onClick: () => void;
  children: ReactNode;
}

export function Button({ onClick, children }: ButtonProps) {
  return (
    <button className="btn btn-primary" onClick={onClick}>
      <span className="btn-label">{children}</span>
    </button>
  );
}
