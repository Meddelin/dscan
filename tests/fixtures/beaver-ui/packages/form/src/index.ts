// `Form.Item` shape (§3.1 вариант 3) — exposed as Form with subcomponents.
const Form = (_props: { onSubmit: () => void }) => null;
Form.Item = (_props: { name: string }) => null;
Form.Section = (_props: { title: string }) => null;

export { Form };
