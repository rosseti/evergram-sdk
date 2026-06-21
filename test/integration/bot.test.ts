import { afterEach, describe, expect, it, vi } from "vitest";
import { EvergramBot } from "../../src/bot";
import { freshIdentity, WS_URL } from "./_helpers";

// Requires the local stack up — see sdk/README.md's "Testing" section.

const openBots: EvergramBot[] = [];

afterEach(() => {
  while (openBots.length) openBots.pop()!.stop();
});

describe("EvergramBot.start() — skips a redundant setProfile round trip", () => {
  it("calls setProfile on first start, when no nickname is set yet", async () => {
    const identity = freshIdentity();
    const bot = new EvergramBot({ url: WS_URL, ...identity, name: "Bot One" });
    openBots.push(bot);

    const setProfile = vi.spyOn(bot.core, "setProfile");
    await bot.start();

    expect(setProfile).toHaveBeenCalledWith({ nickname: "Bot One" });
  });

  it("skips setProfile on a later start once authResponse already reports the same nickname", async () => {
    const identity = freshIdentity();

    const first = new EvergramBot({ url: WS_URL, ...identity, name: "Bot Two" });
    openBots.push(first);
    await first.start();
    first.stop();

    // Same wallet+device, fresh connection — mirrors a process restart.
    const second = new EvergramBot({ url: WS_URL, ...identity, name: "Bot Two" });
    openBots.push(second);
    const setProfile = vi.spyOn(second.core, "setProfile");
    await second.start();

    expect(setProfile).not.toHaveBeenCalled();
  });

  it("calls setProfile again if the requested name changed since the last setProfile", async () => {
    const identity = freshIdentity();

    const first = new EvergramBot({ url: WS_URL, ...identity, name: "Bot Three" });
    openBots.push(first);
    await first.start();
    first.stop();

    const second = new EvergramBot({ url: WS_URL, ...identity, name: "Bot Three Renamed" });
    openBots.push(second);
    const setProfile = vi.spyOn(second.core, "setProfile");
    await second.start();

    expect(setProfile).toHaveBeenCalledWith({ nickname: "Bot Three Renamed" });
  });
});
