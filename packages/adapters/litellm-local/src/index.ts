export const type = "litellm_local";
export const label = "LiteLLM (gateway)";

/** Default LiteLLM gateway on the IntegriBilt stack (SVR02). Overridable per agent. */
export const DEFAULT_BASE_URL = "http://192.168.254.2:4000";
export const DEFAULT_CHAT_COMPLETIONS_PATH = "/v1/chat/completions";

/**
 * LiteLLM proxies many models behind one OpenAI-compatible endpoint and the set
 * varies per gateway/account. Rather than hard-code ids that may not exist, the
 * dropdown is left empty: type the model id you want (e.g. an alias like
 * `flagship`/`balanced`/`fast`, or a concrete id) and run `GET {baseUrl}/v1/models`
 * to discover what your gateway serves.
 */
export const models: { id: string; label: string }[] = [];

export const agentConfigurationDoc = `# litellm_local agent configuration

Adapter: litellm_local

Calls a LiteLLM gateway's OpenAI-compatible Chat Completions endpoint over HTTP.
This is a single-turn chat agent: it sends the rendered prompt (plus any prior
conversation) and records the model's text reply. It has NO shell, file editing,
or tool access — it cannot call the Paperclip API or run commands itself.

Use when:
- You want a lightweight reasoning/text agent (summarize, review, classify, draft, plan)
  backed by any model your LiteLLM gateway serves
- You want real token usage and (when LiteLLM reports it) per-call cost accounting
- You want conversation continuity across heartbeats without running a local CLI

Don't use when:
- The agent must edit files, run shell commands, or call the Paperclip API to act on work
  (use a coding-agent adapter like claude_local / codex_local / opencode_local — those can be
  pointed at this same LiteLLM gateway via their OPENAI_BASE_URL/key env)
- You need provider-native tool-calling loops (not implemented here)

Core fields:
- baseUrl (string, optional): LiteLLM gateway base URL. Defaults to ${DEFAULT_BASE_URL}.
- chatCompletionsPath (string, optional): path appended to baseUrl. Defaults to ${DEFAULT_CHAT_COMPLETIONS_PATH}.
- model (string, required): the model id / alias to request (e.g. flagship, balanced, fast, or a concrete id).
- systemPrompt (string, optional): system message prepended to every request.
- instructionsFilePath (string, optional): absolute path to a markdown file; its contents are appended to the system message.
- promptTemplate (string, optional): user-message template (\`{{path.to.value}}\` rendering).
- temperature (number, optional): sampling temperature.
- maxTokens (number, optional): max_tokens for the completion.
- topP (number, optional): top_p nucleus sampling.
- extraBody (object, optional): extra JSON fields merged into the request body (e.g. provider-specific params).
- headers (object, optional): extra HTTP headers merged into the request.

Auth:
- apiKey (string, optional): LiteLLM virtual key sent as \`Authorization: Bearer <key>\`.
- Or set the key via env (env.LITELLM_API_KEY) so it is never placed in the prompt.
- If neither is set the request is sent without an Authorization header (works only for an open gateway).

Operational fields:
- timeoutSec (number, optional): request timeout in seconds (default 300).

Notes:
- Conversation history is persisted in the session and replayed on each run so the model has context.
  Paperclip's session compaction rotates the conversation when it grows too large.
- The endpoint is expected to be OpenAI Chat Completions compatible (\`choices[0].message.content\`, \`usage\`).
- Cost is read from the \`x-litellm-response-cost\` response header or \`_hidden_params.response_cost\` when present.
`;
