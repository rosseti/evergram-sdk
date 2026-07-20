import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The integration suite drives a single local HotPocket node (roundtime
    // ~4s in dev — see .contractdata/cfg/hp.cfg) through multiple
    // sequential consensus round trips per test (register, auth, create
    // chat...). Running test files in parallel multiplies that contention
    // and pushes otherwise-healthy flows past any reasonable timeout — run
    // files one at a time instead. Unit tests don't care either way.
    fileParallelism: false,
  },
});
