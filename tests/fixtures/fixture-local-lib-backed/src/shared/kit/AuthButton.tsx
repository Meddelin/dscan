// Beaver-backed: imports Button from @beaver-ui. Prescan should flag this file
// as Beaver-backed and consumers get adoption/beaver-backed-wrapper.
import { Button } from '@beaver-ui/button';

export function AuthButton({ label }: { label: string }) {
  return <Button>{label}</Button>;
}
