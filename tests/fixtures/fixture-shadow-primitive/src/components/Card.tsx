import type { ReactNode } from 'react';

interface CardProps {
  title: string;
  children: ReactNode;
}

export function Card({ title, children }: CardProps) {
  return (
    <section className="card">
      <header className="card-header">
        <h3>{title}</h3>
      </header>
      <div className="card-body">{children}</div>
    </section>
  );
}
