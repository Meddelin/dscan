import { Button } from '@beaver-ui/button';
import { SideNavigation, SideNavigationItem } from '@beaver-ui/side-navigation';
import { Subheader } from '@beaver-ui/subheader';

export function App() {
  return (
    <div>
      <Subheader title="Dashboard" />
      <SideNavigation>
        <SideNavigationItem label="Home" />
        <SideNavigationItem label="Reports" />
      </SideNavigation>
      <main>
        <Button variant="primary">Save</Button>
        <Button variant="secondary">Cancel</Button>
      </main>
    </div>
  );
}
