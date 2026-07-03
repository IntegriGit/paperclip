import { describe, expect, it } from "vitest";
import { isAntigravityUnknownSessionError, parseAntigravityOutput } from "./parse.js";
import { sessionCodec } from "./index.js";
import { buildAntigravityLocalConfig } from "../ui/build-config.js";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";

describe("parseAntigravityOutput", () => {
  it("treats stdout as the response summary and trims it", () => {
    const parsed = parseAntigravityOutput("  pong\nmore output  \n", "");
    expect(parsed.summary).toBe("pong\nmore output");
    expect(parsed.errorMessage).toBeNull();
  });

  it("surfaces the first non-empty stderr line as an error hint", () => {
    const parsed = parseAntigravityOutput("", "\n  boom: it failed\nsecond line\n");
    expect(parsed.errorMessage).toBe("boom: it failed");
  });
});

describe("isAntigravityUnknownSessionError", () => {
  it("detects a missing conversation", () => {
    expect(isAntigravityUnknownSessionError("", "error: conversation abc not found")).toBe(true);
    expect(isAntigravityUnknownSessionError("", "unknown conversation: abc")).toBe(true);
  });

  it("detects the Windows brain-path failure", () => {
    expect(
      isAntigravityUnknownSessionError("", "The system cannot find the path specified."),
    ).toBe(true);
  });

  it("returns false for normal output", () => {
    expect(isAntigravityUnknownSessionError("hello there", "")).toBe(false);
  });
});

describe("sessionCodec", () => {
  it("round-trips a conversation id with cwd", () => {
    const params = { sessionId: "11111111-2222-3333-4444-555555555555", cwd: "/work/proj" };
    const serialized = sessionCodec.serialize(params);
    expect(serialized).toEqual(params);
    const deserialized = sessionCodec.deserialize(serialized);
    expect(deserialized).toEqual(params);
    expect(sessionCodec.getDisplayId?.(params)).toBe(params.sessionId);
  });

  it("accepts a conversationId alias", () => {
    const deserialized = sessionCodec.deserialize({ conversationId: "abc", cwd: "/x" });
    expect(deserialized).toEqual({ sessionId: "abc", cwd: "/x" });
  });

  it("returns null without a session id", () => {
    expect(sessionCodec.serialize({ cwd: "/x" })).toBeNull();
    expect(sessionCodec.deserialize({ foo: "bar" })).toBeNull();
  });
});

describe("buildAntigravityLocalConfig", () => {
  const base: CreateConfigValues = {
    adapterType: "antigravity_local",
    cwd: "/work/proj",
    promptTemplate: "",
    model: "",
    thinkingEffort: "",
    chrome: false,
    dangerouslySkipPermissions: true,
    search: false,
    fastMode: false,
    dangerouslyBypassSandbox: false,
    command: "",
    args: "",
    extraArgs: "",
    envVars: "",
    envBindings: {},
    url: "",
    bootstrapPrompt: "",
    maxTurnsPerRun: 0,
    heartbeatEnabled: false,
    intervalSec: 0,
  };

  it("omits model when blank and defaults dangerouslySkipPermissions to true", () => {
    const ac = buildAntigravityLocalConfig({ ...base });
    expect(ac.cwd).toBe("/work/proj");
    expect("model" in ac).toBe(false);
    expect(ac.dangerouslySkipPermissions).toBe(true);
    expect(ac.timeoutSec).toBe(0);
    expect(ac.graceSec).toBe(20);
  });

  it("keeps model and extraArgs when provided and respects an off permission toggle", () => {
    const ac = buildAntigravityLocalConfig({
      ...base,
      model: "some-model",
      extraArgs: "--foo, --bar",
      dangerouslySkipPermissions: false,
    });
    expect(ac.model).toBe("some-model");
    expect(ac.extraArgs).toEqual(["--foo", "--bar"]);
    expect(ac.dangerouslySkipPermissions).toBe(false);
  });
});
