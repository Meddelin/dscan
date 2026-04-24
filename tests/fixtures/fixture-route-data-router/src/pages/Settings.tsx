import { Button } from '@beaver-ui/button';
import { Header } from '../shared/Header';
import { PermissionGate } from '../providers/PermissionGate';

export function Settings() {
  return (
    <PermissionGate>
      <Header title="Settings" />
      <Button variant="secondary">Save</Button>
    </PermissionGate>
  );
}
