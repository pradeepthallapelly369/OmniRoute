/**
 * Extract usage from non-streaming response body
 * Handles different provider response formats
 */
import { carryEstimatedUsageMarker } from "../utils/usageTracking.ts";

export function extractUsageFromResponse(responseBody, provider) {
  if (!responseBody || typeof responseBody !== "object") return null;
  const providerId = typeof provider === "string" ? provider.toLowerCase() : "";
  const isClaudeProvider =
    providerId === "claude" ||
    providerId === "anthropic" ||
    providerId === "vertex" ||
    providerId === "vertex-partner" ||
    providerId.startsWith("anthropic-compatible");

  // OpenAI format (has prompt_tokens / completion_tokens)
  if (
    responseBody.usage &&
    typeof responseBody.usage === "object" &&
    (responseBody.usage.prompt_tokens !== undefined ||
      responseBody.usage.input_tokens !== undefined ||
      responseBody.usage.completion_tokens !== undefined ||
      responseBody.usage.output_tokens !== undefined)
  ) {
    const cacheCreationTokens =
      responseBody.usage.cache_creation_input_tokens ??
      responseBody.usage.prompt_tokens_details?.cache_creation_tokens ??
      responseBody.usage.input_tokens_details?.cache_creation_tokens ??
      responseBody.usage.prompt_tokens_details?.cache_write_tokens ??
      responseBody.usage.input_tokens_details?.cache_write_tokens ??
      responseBody.usage.cache_write_tokens;
    const openAiUsage = {
      ...(responseBody.usage.prompt_tokens !== undefined ||
      responseBody.usage.input_tokens !== undefined
        ? { prompt_tokens: responseBody.usage.prompt_tokens ?? responseBody.usage.input_tokens }
        : {}),
      ...(responseBody.usage.completion_tokens !== undefined ||
      responseBody.usage.output_tokens !== undefined
        ? {
            completion_tokens:
              responseBody.usage.completion_tokens ?? responseBody.usage.output_tokens,
          }
        : {}),
      // DeepSeek native API uses flat prompt_cache_hit_tokens (NOT
      // prompt_tokens_details.cached_tokens). Fall back to it so V4 cache
      // gets surfaced into kanban call_logs alongside the OpenAI/Claude paths.
      cached_tokens:
        responseBody.usage.prompt_tokens_details?.cached_tokens ??
        responseBody.usage.input_tokens_details?.cached_tokens ??
        responseBody.usage.prompt_cache_hit_tokens ??
        responseBody.usage.cached_tokens ??
        responseBody.usage.cache_read_input_tokens,
      // Cache WRITE tokens. Anthropic models reached through an OpenAI-compatible
      // endpoint carry the count nested in prompt/input token details (see
      // translator/response/claude-to-openai.ts, #2215) or under the
      // `cache_write_tokens` alias used by OpenRouter/Devin/codex-chatgpt-web.
      // Reading only the flat Anthropic key made the dashboard show "Cache Write:
      // N/A" for the very same model that reports a real count natively.
      // Only emit the key when a provider actually reported one, so a provider
      // with no cache-write concept (plain gpt/codex) stays N/A instead of 0.
      ...(cacheCreationTokens !== undefined
        ? { cache_creation_input_tokens: cacheCreationTokens }
        : {}),
      reasoning_tokens:
        responseBody.usage.completion_tokens_details?.reasoning_tokens ??
        responseBody.usage.output_tokens_details?.reasoning_tokens ??
        responseBody.usage.reasoning_tokens,
      // xAI's exact provider-reported cost (port of decolua/9router#2453, capability A —
      // @ryanngit). Only set the key when present so non-xAI OpenAI-shaped usage
      // (Codex, DeepSeek, etc.) is unaffected. Ticks → USD conversion happens in
      // costCalculator.ts, not here.
      ...(typeof responseBody.usage.cost_in_usd_ticks === "number" &&
      Number.isFinite(responseBody.usage.cost_in_usd_ticks) &&
      responseBody.usage.cost_in_usd_ticks >= 0
        ? { cost_in_usd_ticks: responseBody.usage.cost_in_usd_ticks }
        : {}),
    };
    return carryEstimatedUsageMarker(responseBody.usage, openAiUsage);
  }

  // Claude format
  if (
    isClaudeProvider &&
    responseBody.usage &&
    typeof responseBody.usage === "object" &&
    (responseBody.usage.input_tokens !== undefined ||
      responseBody.usage.output_tokens !== undefined)
  ) {
    const inputTokens = responseBody.usage.input_tokens;
    const cacheRead = responseBody.usage.cache_read_input_tokens;
    const cacheCreation = responseBody.usage.cache_creation_input_tokens;

    // Total prompt tokens = input + cache_read + cache_creation (per Claude API docs)
    const promptReported =
      inputTokens !== undefined || cacheRead !== undefined || cacheCreation !== undefined;
    const inputWasEstimated =
      Reflect.get(responseBody.usage, Symbol.for("omniroute.usage.input-estimated")) === true;
    const normalized = {
      ...(promptReported
        ? {
            prompt_tokens: inputWasEstimated
              ? typeof inputTokens === "number"
                ? inputTokens
                : 0
              : (typeof inputTokens === "number" ? inputTokens : 0) +
                (typeof cacheRead === "number" ? cacheRead : 0) +
                (typeof cacheCreation === "number" ? cacheCreation : 0),
          }
        : {}),
      ...(responseBody.usage.output_tokens !== undefined
        ? { completion_tokens: responseBody.usage.output_tokens }
        : {}),
      ...(cacheRead !== undefined ? { cache_read_input_tokens: cacheRead } : {}),
      ...(cacheCreation !== undefined ? { cache_creation_input_tokens: cacheCreation } : {}),
      ...(typeof responseBody.usage.output_tokens_details?.thinking_tokens === "number"
        ? { reasoning_tokens: responseBody.usage.output_tokens_details.thinking_tokens }
        : {}),
    };
    return carryEstimatedUsageMarker(responseBody.usage, normalized);
  }

  // OpenAI Responses API format (input_tokens / output_tokens)
  const responsesUsage = responseBody.response?.usage || responseBody.usage;
  if (
    responsesUsage &&
    typeof responsesUsage === "object" &&
    (responsesUsage.input_tokens !== undefined || responsesUsage.output_tokens !== undefined)
  ) {
    const normalized = {
      ...(responsesUsage.input_tokens !== undefined
        ? { prompt_tokens: responsesUsage.input_tokens }
        : {}),
      ...(responsesUsage.output_tokens !== undefined
        ? { completion_tokens: responsesUsage.output_tokens }
        : {}),
      ...(responsesUsage.cache_read_input_tokens !== undefined
        ? { cache_read_input_tokens: responsesUsage.cache_read_input_tokens }
        : {}),
      ...(responsesUsage.input_tokens_details?.cached_tokens !== undefined ||
      responsesUsage.prompt_tokens_details?.cached_tokens !== undefined
        ? {
            cached_tokens:
              responsesUsage.input_tokens_details?.cached_tokens ??
              responsesUsage.prompt_tokens_details?.cached_tokens ??
              responsesUsage.cache_read_input_tokens,
          }
        : {}),
      ...(responsesUsage.cache_creation_input_tokens !== undefined
        ? { cache_creation_input_tokens: responsesUsage.cache_creation_input_tokens }
        : {}),
      ...(responsesUsage.output_tokens_details?.reasoning_tokens !== undefined ||
      responsesUsage.completion_tokens_details?.reasoning_tokens !== undefined ||
      responsesUsage.reasoning_tokens !== undefined
        ? {
            reasoning_tokens:
              responsesUsage.output_tokens_details?.reasoning_tokens ??
              responsesUsage.completion_tokens_details?.reasoning_tokens ??
              responsesUsage.reasoning_tokens,
          }
        : {}),
    };
    return carryEstimatedUsageMarker(responsesUsage, normalized);
  }

  // Gemini format. Antigravity / gemini-cli wrap the payload in
  // { response: { ... } } — read the envelope so non-streaming requests do
  // not silently log zero usage (port of decolua/9router#59d858b).
  const usageMetadata = responseBody.usageMetadata || responseBody.response?.usageMetadata;
  if (usageMetadata && typeof usageMetadata === "object") {
    // Gemini reports thoughts outside candidates. Fold them into completion so
    // every provider keeps reasoning as a subset of completion tokens.
    const thoughts = usageMetadata.thoughtsTokenCount || 0;
    const normalized = {
      ...(usageMetadata.promptTokenCount !== undefined
        ? { prompt_tokens: usageMetadata.promptTokenCount }
        : {}),
      ...(usageMetadata.candidatesTokenCount !== undefined ||
      usageMetadata.thoughtsTokenCount !== undefined
        ? {
            completion_tokens:
              (usageMetadata.candidatesTokenCount || 0) + (usageMetadata.thoughtsTokenCount || 0),
          }
        : {}),
      ...(usageMetadata.cachedContentTokenCount !== undefined
        ? { cached_tokens: usageMetadata.cachedContentTokenCount }
        : {}),
      ...(usageMetadata.thoughtsTokenCount !== undefined
        ? { reasoning_tokens: usageMetadata.thoughtsTokenCount }
        : {}),
    };
    return carryEstimatedUsageMarker(usageMetadata, normalized);
  }

  return null;
}
