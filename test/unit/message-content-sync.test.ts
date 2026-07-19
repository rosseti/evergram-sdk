import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// sdk/src/message-content.ts is a manual copy of webapp's canonical message
// typing module — there is no build-time mechanism enforcing that copy stays
// in sync, only this test (mirrors proto-sync.test.ts's pattern). If this
// fails, someone changed one side (most likely webapp/app/lib/message-content.ts)
// without mirroring it here.
//
// Only meaningful in the monorepo dev checkout, where webapp/ is a sibling
// of sdk/ — evergram-sdk is also published as its own standalone repo (see
// CI), which has no webapp/ checkout to compare against at all. Skip rather
// than fail in that case; this stays a real gate wherever the sibling exists.
const webappPath = path.join(__dirname, "../../../webapp/app/lib/message-content.ts");

describe.skipIf(!existsSync(webappPath))("message-content sync", () => {
  it("sdk's message-content.ts is byte-identical to webapp's canonical copy", () => {
    const sdkCopy = readFileSync(path.join(__dirname, "../../src/message-content.ts"), "utf8");
    const webappCopy = readFileSync(webappPath, "utf8");

    expect(sdkCopy).toBe(webappCopy);
  });
});
