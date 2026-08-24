import { describe, expect, it } from "vitest";
import { createSerialQueue } from "../../examples/xahau-tip-bot/serial-queue.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("xahau-tip-bot createSerialQueue", () => {
  it("runs jobs strictly one at a time, in call order", async () => {
    const enqueue = createSerialQueue();
    const order: number[] = [];

    const first = deferred<void>();
    const job1 = enqueue(async () => {
      order.push(1);
      await first.promise;
      order.push(2);
    });
    // job2 must not start (and thus not push 3) until job1's await resolves.
    const job2 = enqueue(async () => {
      order.push(3);
    });

    // Give job1 a chance to run up to its await; job2 must still be blocked.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([1]);

    first.resolve();
    await Promise.all([job1, job2]);

    expect(order).toEqual([1, 2, 3]);
  });

  it("propagates a job's rejection to its own caller without wedging later jobs", async () => {
    const enqueue = createSerialQueue();

    await expect(
      enqueue(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await expect(enqueue(async () => "ok")).resolves.toBe("ok");
  });

  it("returns each job's own resolved value", async () => {
    const enqueue = createSerialQueue();

    const a = enqueue(async () => 1);
    const b = enqueue(async () => 2);

    expect(await a).toBe(1);
    expect(await b).toBe(2);
  });
});
