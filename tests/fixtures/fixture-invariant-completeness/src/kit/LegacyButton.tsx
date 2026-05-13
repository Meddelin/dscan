// Primitive name + no Beaver imports + substantial markup → confirmed shadow.
export function LegacyButton({ label }: { label: string }) {
  return (
    <button className="legacy">
      <span className="legacy-inner">
        <span className="legacy-icon">★</span>
        <span className="legacy-label">{label}</span>
        <span className="legacy-tail">→</span>
      </span>
    </button>
  );
}
