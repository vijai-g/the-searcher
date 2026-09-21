import Anthropic from '@anthropic-ai/sdk';
import * as log from '../util/logger.js';

/**
 * Chat abstraction over the providers The Searcher can talk to.
 *
 * OpenRouter speaks the OpenAI chat-completions dialect; CodeMie and Anthropic
 * speak the Anthropic Messages dialect. Everything above this module just calls
 * `complete({ system, user })` and gets text back.
 */
export function createChatClient(chatConfig) {
  if (!chatConfig?.apiKey) return null;

  return chatConfig.provider === 'openrouter'
    ? openRouterClient(chatConfig)
    : anthropicClient(chatConfig);
}

function openRouterClient({ apiKey, baseUrl, model, referer, title }) {
  return {
    provider: 'openrouter',
    model,

    async complete({ system, user, maxTokens = 8000, temperature = 0.2, json: wantJson = false }) {
      const body = {
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: maxTokens,
        temperature,
        usage: { include: true },
      };
      // Structured-output mode where the model supports it; OpenRouter rejects it
      // with a 400 otherwise, in which case we retry without.
      if (wantJson) {
        body.response_format = { type: 'json_object' };
        // Thinking models spend reasoning tokens out of the same max_tokens budget,
        // which once truncated a 210-item plan mid-array. Structured output needs
        // little deliberation; keep the budget for the answer.
        body.reasoning = { effort: 'low' };
      }

      let res = await postJson(body);
      if (wantJson && res.status === 400) {
        delete body.response_format;
        res = await postJson(body);
      }
      async function postJson(payload) {
        return fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          // OpenRouter uses these for attribution on its dashboard; both optional.
          ...(referer ? { 'HTTP-Referer': referer } : {}),
          ...(title ? { 'X-Title': title } : {}),
        },
        body: JSON.stringify(payload),
        });
      }

      const text = await res.text();
      if (!res.ok) {
        throw new Error(`OpenRouter ${res.status}: ${summarise(text)}`);
      }

      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`OpenRouter returned non-JSON: ${summarise(text)}`);
      }

      // OpenRouter reports upstream provider failures in-band with HTTP 200.
      if (json.error) throw new Error(`OpenRouter: ${json.error.message || JSON.stringify(json.error)}`);

      const content = json.choices?.[0]?.message?.content;
      if (!content) throw new Error(`OpenRouter returned no content: ${summarise(text)}`);

      // Surface what the call actually cost - reasoning tokens in particular are
      // invisible in the response text but come out of the same budget.
      const u = json.usage || {};
      const reasoning = u.completion_tokens_details?.reasoning_tokens;
      const finish = json.choices?.[0]?.finish_reason || json.choices?.[0]?.native_finish_reason;
      log.info(
        `  ${model}: ${u.prompt_tokens ?? '?'} in, ${u.completion_tokens ?? '?'} out` +
        (reasoning != null ? ` (${reasoning} reasoning)` : '') +
        (u.cost != null ? `, $${Number(u.cost).toFixed(4)}` : '') +
        (finish ? `, finish=${finish}` : '')
      );
      return content;
    },
  };
}

function anthropicClient({ apiKey, baseUrl, model }) {
  const client = new Anthropic({ apiKey, baseURL: baseUrl || undefined });
  return {
    provider: 'anthropic',
    model,

    async complete({ system, user, maxTokens = 8000, temperature = 0.2 }) {
      // json mode is a prompt-level contract on this dialect; nothing to set.
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        temperature,
        system,
        messages: [{ role: 'user', content: user }],
      });
      return response.content.find((b) => b.type === 'text')?.text || '';
    },
  };
}

function summarise(text) {
  return String(text).replace(/\s+/g, ' ').slice(0, 300);
}
