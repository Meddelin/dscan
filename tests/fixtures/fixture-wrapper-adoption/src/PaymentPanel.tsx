import { Button } from '@beaver-ui/button';
import { Subheader } from '@beaver-ui/subheader';

// Composition over Beaver with no customization — small markup (<5 JSX
// elements) and no className/style/styled on any Beaver component → should
// land as adoption/beaver-composition (§3.6).
export function PaymentPanel() {
  return (
    <section>
      <Subheader title="Settings" />
      <Button variant="primary">Save</Button>
    </section>
  );
}
