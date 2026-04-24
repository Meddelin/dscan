// Shared header — imported by BOTH Dashboard and Settings pages.
// Expected route binding: { kind: 'shared', paths: ['/dashboard', '/settings'] }.
export function Header({ title }: { title: string }) {
  return <h1>{title}</h1>;
}
