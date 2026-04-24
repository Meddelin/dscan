import { Button } from '@beaver-ui/button';

// Purist shadow: any className on a Beaver component → shadow regardless of
// whether Beaver technically accepts that prop (§3.6).
export function BrandButton({ label }: { label: string }) {
  return <Button className="brand-red">{label}</Button>;
}
