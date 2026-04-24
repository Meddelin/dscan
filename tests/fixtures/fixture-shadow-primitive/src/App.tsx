import { Button } from './components/Button';
import { Card } from './components/Card';

export function App() {
  return (
    <div>
      <Card title="Settings">
        <Button onClick={() => {}}>Save settings</Button>
        <Button onClick={() => {}}>Discard</Button>
      </Card>
      <Card title="Profile">
        <Button onClick={() => {}}>Edit profile</Button>
      </Card>
    </div>
  );
}
