import type { UIAdapterModule } from "../types";
import {
  buildLiteLLMLocalConfig,
  parseLiteLLMStdoutLine,
} from "@paperclipai/adapter-litellm-local/ui";
import { LiteLLMLocalConfigFields } from "./config-fields";

export const litellmLocalUIAdapter: UIAdapterModule = {
  type: "litellm_local",
  label: "LiteLLM (gateway)",
  parseStdoutLine: parseLiteLLMStdoutLine,
  ConfigFields: LiteLLMLocalConfigFields,
  buildAdapterConfig: buildLiteLLMLocalConfig,
};
