import { Form } from '@beaver-ui/form';

export function App() {
  return (
    <Form onSubmit={() => {}}>
      <Form.Item name="email" />
      <Form.Section title="Address" />
    </Form>
  );
}
