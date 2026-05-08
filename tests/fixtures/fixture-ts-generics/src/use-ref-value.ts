// Pure .ts file — generics + arrow casts must NOT be misread as JSX.
// This file regresses: prior parser ran with jsx=true on .ts and threw
// "Unexpected token. Did you mean {'>'} or &gt;?" at the angle-bracket cast.

export const wrap = <T,>(value: T): T => value;

export function useRefValue<T>(initial: T): { current: T } {
  return { current: initial };
}

type Pair<A, B> = { a: A; b: B };

export const swap = <A, B>(p: Pair<A, B>): Pair<B, A> => ({ a: p.b, b: p.a });
