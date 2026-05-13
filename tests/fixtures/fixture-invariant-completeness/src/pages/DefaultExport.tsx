// Default export with a `<Card>` name. Consumer imports as `Anything`,
// validating that buildPending resolves the symbol as 'default'.
export default function Card() {
  return (
    <div className="card-default">
      <header>card</header>
      <div>body</div>
      <footer>foot</footer>
      <span>extra</span>
    </div>
  );
}
