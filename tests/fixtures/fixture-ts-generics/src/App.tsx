import { Button } from '@beaver-ui/button';
import { wrap } from './use-ref-value';

export function App() {
  return <Button>{wrap('hello')}</Button>;
}
