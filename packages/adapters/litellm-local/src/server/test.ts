import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asNumber, asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_BASE_URL } from "../index.js";

const ADAPTER_TYPE = "litellm_local";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const baseUrl = asString(config.baseUrl, DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL;
  const model = asString(config.model, "").trim();
  const envConfig = parseObject(config.env);
  const apiKey =
    asString(config.apiKey, "").trim() ||
    (typeof envConfig.LITELLM_API_KEY === "string" ? envConfig.LITELLM_API_KEY.trim() : "") ||
    (typeof process.env.LITELLM_API_KEY === "string" ? process.env.LITELLM_API_KEY.trim() : "");

  let parsedBase: URL | null = null;
  try {
    parsedBase = new URL(baseUrl);
    checks.push({
      code: "litellm_base_url_valid",
      level: "info",
      message: `Gateway base URL is valid: ${baseUrl}`,
    });
  } catch {
    checks.push({
      code: "litellm_base_url_invalid",
      level: "error",
      message: "Gateway base URL is not a valid URL.",
      detail: baseUrl,
    });
  }

  if (!model) {
    checks.push({
      code: "litellm_model_missing",
      level: "warn",
      message: "No `model` configured.",
      hint: "Set a model id (e.g. flagship/balanced/fast or a concrete id). Query GET {baseUrl}/v1/models to discover ids.",
    });
  } else {
    checks.push({ code: "litellm_model_configured", level: "info", message: `Configured model: ${model}` });
  }

  if (!apiKey) {
    checks.push({
      code: "litellm_api_key_missing",
      level: "warn",
      message: "No API key configured (apiKey or env.LITELLM_API_KEY).",
      hint: "Most LiteLLM gateways require a virtual key. Set one unless the gateway is open.",
    });
  } else {
    checks.push({ code: "litellm_api_key_present", level: "info", message: "API key is configured." });
  }

  if (parsedBase) {
    const probeTimeoutSec = Math.max(2, asNumber(config.helloProbeTimeoutSec, 15));
    const modelsUrl = `${baseUrl.replace(/\/+$/, "")}/v1/models`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), probeTimeoutSec * 1000);
    try {
      const res = await fetch(modelsUrl, {
        method: "GET",
        headers: {
          accept: "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        signal: controller.signal,
      });
      if (res.status === 401 || res.status === 403) {
        checks.push({
          code: "litellm_auth_failed",
          level: "warn",
          message: `Gateway rejected the API key (HTTP ${res.status}).`,
          hint: "Verify the LiteLLM virtual key is valid and not expired.",
        });
      } else if (res.ok) {
        let count: number | null = null;
        try {
          const body = (await res.json()) as { data?: unknown[] };
          if (Array.isArray(body?.data)) count = body.data.length;
        } catch {
          // ignore non-JSON bodies
        }
        checks.push({
          code: "litellm_reachable",
          level: "info",
          message: "Gateway is reachable and the key is accepted.",
          detail: count !== null ? `${count} model(s) available.` : undefined,
        });
      } else {
        checks.push({
          code: "litellm_probe_unexpected",
          level: "warn",
          message: `Gateway returned HTTP ${res.status} for ${modelsUrl}.`,
        });
      }
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      checks.push({
        code: aborted ? "litellm_probe_timed_out" : "litellm_probe_failed",
        level: "error",
        message: aborted
          ? `Gateway did not respond within ${probeTimeoutSec}s.`
          : "Could not reach the gateway.",
        detail: err instanceof Error ? err.message : String(err),
        hint: `Verify the gateway is running and reachable at ${baseUrl}.`,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    adapterType: ADAPTER_TYPE,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
