import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// sdk/src/proto/evergram.proto is a manual copy of webapp's canonical
// schema (see README: "re-run npm run protoc here after the canonical
// schema changes") — there is no build-time mechanism enforcing that copy
// stays in sync, only this test. If this fails, someone changed one side
// (most likely webapp/app/proto/evergram.proto) without mirroring it here
// and regenerating sdk/src/proto/evergram.ts.
//
// Only meaningful in the monorepo dev checkout, where webapp/ is a sibling
// of sdk/ — evergram-sdk is also published as its own standalone repo (see
// CI), which has no webapp/ checkout to compare against at all. Skip rather
// than fail in that case; this stays a real gate wherever the sibling exists.
const webappProtoPath = path.join(__dirname, "../../../webapp/app/proto/evergram.proto");

describe.skipIf(!existsSync(webappProtoPath))("proto schema sync", () => {
  it("sdk's evergram.proto is byte-identical to webapp's canonical copy", () => {
    const sdkProto = readFileSync(path.join(__dirname, "../../src/proto/evergram.proto"), "utf8");
    const webappProto = readFileSync(webappProtoPath, "utf8");

    expect(sdkProto).toBe(webappProto);
  });
});
