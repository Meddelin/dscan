// Another .ts file with structural shape that looks JSX-y.

export type Retry<T> = {
  attempts: number;
  factory: () => Promise<T>;
};

export async function retryUntilDone<T>(opts: Retry<T>): Promise<T> {
  let last: unknown;
  for (let i = 0; i < opts.attempts; i++) {
    try {
      return await opts.factory();
    } catch (err) {
      last = err;
    }
  }
  throw last;
}
