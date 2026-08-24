// Runs enqueued async functions strictly one at a time, in call order.
// Without this, two `!tip`s arriving close together would both call
// xrpl.Client.autofill() concurrently, which reads the account's current
// Sequence independently for each, so the second submission can race the
// first and get rejected (or, worse, silently reuse a Sequence the first
// one also picked). Serializing submissions is the simplest fix: no
// dependency, no distributed lock, just "don't start the next one until the
// previous one has fully settled."
export function createSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve();

  return function run<T>(fn: () => Promise<T>): Promise<T> {
    const result = tail.then(fn, fn);
    // Swallow here, not on `result`: a rejection must still propagate to
    // whoever called run() and awaited `result`. This branch only exists
    // so one failed job doesn't wedge the queue for every job after it.
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}
