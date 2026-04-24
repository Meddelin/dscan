// NOT Beaver-backed: no Beaver imports. Living inside a "partially-beaver-backed"
// lib per config, but prescan flips this particular component to unbacked,
// which should override the config.kind → pending → shadow/possible.
export function BrandLogo() {
  return <div className="brand-logo">★</div>;
}
