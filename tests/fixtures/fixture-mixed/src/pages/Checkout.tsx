import { Button, Subheader } from '@beaver-ui/components';
import { PaymentForm } from '@team/kit-backed';
import { LegacyInput } from '@team/legacy-kit';
import { Modal } from '../local/Modal';
import { AnalyticsProvider } from '../local/AnalyticsProvider';

export function Checkout() {
  return (
    <AnalyticsProvider>
      <Subheader title="Checkout" />
      <PaymentForm />
      <LegacyInput label="Promo code" />
      <Modal>
        <Button variant="primary">Pay now</Button>
      </Modal>
    </AnalyticsProvider>
  );
}
