// Reached only via two hops of star re-exports (kit/index.ts →
// kit/widgets/index.ts → here). Without fixpoint aliasing the consumer's
// `import { LegacyCard } from './kit'` would miss the profile entirely.
export function LegacyCard({ title }: { title: string }) {
  return (
    <section className="legacy-card">
      <header><h3>{title}</h3></header>
      <div className="legacy-card-body">
        <p>body</p>
        <p>more body</p>
      </div>
    </section>
  );
}
