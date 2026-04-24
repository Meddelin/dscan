import { Button } from '@beaver-ui/button';
// Path alias — should resolve to src/components/LocalPanel.tsx via tsconfig paths.
import { LocalPanel } from '@/components/LocalPanel';

export function App() {
  return (
    <LocalPanel>
      <Button>Submit</Button>
    </LocalPanel>
  );
}
