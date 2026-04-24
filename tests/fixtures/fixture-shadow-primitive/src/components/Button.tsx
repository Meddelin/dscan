import type { ReactNode } from 'react';

interface ButtonProps {
  onClick: () => void;
  children: ReactNode;
  loading?: boolean;
  icon?: ReactNode;
}

// Markup with 5+ JSX elements + primitive name + no Beaver imports →
// confirmed shadow (§3.5).
export function Button({ onClick, children, loading, icon }: ButtonProps) {
  return (
    <button className="btn btn-primary" onClick={onClick}>
      <span className="btn-inner">
        <span className="btn-icon">{icon}</span>
        <span className="btn-label">{children}</span>
        <span className="btn-spinner" data-loading={loading}>
          <i className="spinner" />
        </span>
      </span>
    </button>
  );
}
