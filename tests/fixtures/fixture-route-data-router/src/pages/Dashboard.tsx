import { Button } from '@beaver-ui/button';
import { Header } from '../shared/Header';

export function Dashboard() {
  return (
    <section>
      <Header title="Dashboard" />
      <Button variant="primary">Refresh</Button>
    </section>
  );
}
