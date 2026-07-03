import { describe, expect, it } from "vitest";
import { parseCostHeader, parseLiteLLMResponse } from "./parse.js";
import { sessionCodec } from "./index.js";
import { buildLiteLLMLocalConfig } from "../ui/build-config.js";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";

describe("parseLiteLLMResponse", () => {
  it("extracts content, usage, and hidden cost", () => {
    const parsed = parseLiteLLMResponse({
      model: "balanced",
      choices: [{ message: { role: "assistant", content: "  hello world  " }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 3 },
      },
      _hidden_params: { response_cost: 0.000123 },
    });
    expect(parsed.content).toBe("hello world");
    expect(parsed.finishReason).toBe("stop");
    expect(parsed.model).toBe("balanced");
    expect(parsed.promptTokens).toBe(12);
    expect(parsed.completionTokens).toBe(5);
    expect(parsed.cachedTokens).toBe(3);
    expect(parsed.costUsd).toBeCloseTo(0.000123);
    expect(parsed.errorMessage).toBeNull();
  });

  it("surfaces an error envelope", () => {
    const parsed = parseLiteLLMResponse({ error: { message: "model not found", code: "404" } });
    expect(parsed.errorMessage).toBe("model not found");
    expect(parsed.content).toBe("");
  });

  it("degrades safely on a malformed body", () => {
    const parsed = parseLiteLLMResponse("not json");
    expect(parsed.content).toBe("");
    expect(parsed.promptTokens).toBe(0);
    expect(parsed.costUsd).toBeNull();
  });
});

describe("parseCostHeader", () => {
  it("parses a numeric header", () => {
    expect(parseCostHeader("0.0042")).toBeCloseTo(0.0042);
  });
  it("returns null for missing/invalid", () => {
    expect(parseCostHeader(null)).toBeNull();
    expect(parseCostHeader("n/a")).toBeNull();
  });
});

describe("sessionCodec", () => {
  it("round-trips a conversation", () => {
    const params = {
      sessionId: "litellm-abc",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
      model: "balanced",
      baseUrl: "http://gw:4000",
    };
    const serialized = sessionCodec.serialize(params);
    expect(serialized).toEqual(params);
    expect(sessionCodec.deserialize(serialized)).toEqual(params);
    expect(sessionCodec.getDisplayId?.(params)).toBe("litellm-abc");
  });

  it("drops malformed message entries", () => {
    const deserialized = sessionCodec.deserialize({
      sessionId: "s1",
      messages: [{ role: "user", content: "ok" }, { role: "bogus", content: 1 }, "nope"],
    });
    expect(deserialized).toEqual({ sessionId: "s1", messages: [{ role: "user", content: "ok" }] });
  });

  it("returns null when there is nothing to persist", () => {
    expect(sessionCodec.serialize({ model: "x" })).toBeNull();
  });
});

describe("buildLiteLLMLocalConfig", () => {
  const base: CreateConfigValues = {
    adapterType: "litellm_local",
    cwd: "",
    promptTemplate: "",
    model: "",
    thinkingEffort: "",
    chrome: false,
    dangerouslySkipPermissions: false,
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

  it("defaults the base URL and maps model/system prompt", () => {
    const ac = buildLiteLLMLocalConfig({
      ...base,
      model: "flagship",
      bootstrapPrompt: "You are terse.",
    });
    expect(ac.baseUrl).toBe("http://192.168.254.2:4000");
    expect(ac.model).toBe("flagship");
    expect(ac.systemPrompt).toBe("You are terse.");
  });

  it("uses the provided url and env bindings", () => {
    const ac = buildLiteLLMLocalConfig({
      ...base,
      url: "http://gw:4000",
      envBindings: { LITELLM_API_KEY: "sk-test" },
    });
    expect(ac.baseUrl).toBe("http://gw:4000");
    expect(ac.env).toEqual({ LITELLM_API_KEY: { type: "plain", value: "sk-test" } });
  });
});
