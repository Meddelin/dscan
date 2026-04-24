// Consumer imports only from the aggregator. Scanner should canonicalize
// each usage back to its leaf package via the re-export map.
import { Button, SideNavigation, Subheader } from '@beaver-ui/components';

export function App() {
  return (
    <div>
      <Subheader title="Dashboard" />
      <SideNavigation>
        <Button variant="primary">Click me</Button>
      </SideNavigation>
    </div>
  );
}
