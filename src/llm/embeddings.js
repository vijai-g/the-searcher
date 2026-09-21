const BATCH_SIZE = 96;

/**
 * Embeddings client for OpenAI-dialect `/v1/embeddings` endpoints.
 *
 * OpenRouter serves no embedding models at all, so retrieval always runs through
 * a separate provider — CodeMie's proxy by default. Keeping this split explicit
 * avoids the confusing 404 you would otherwise get from api.anthropic.com, which
 * has no embeddings endpoint either.
 */
export function createEmbeddingsClient(embedConfig) {
  if (!embedConfig?.apiKey || !embedConfig?.baseUrl) return null;

  const { apiKey, baseUrl, model, authStyle } = embedConfig;
  const url = `${baseUrl.replace(/\/+$/, '')}/embeddings`;

  return {
    provider: embedConfig.provider,
    model,

    async embedTexts(texts) {
      const vectors = [];

      for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE);
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(authStyle === 'bearer'
              ? { Authorization: `Bearer ${apiKey}` }
              : { 'x-api-key': apiKey }),
          },
          body: JSON.stringify({ model, input: batch }),
        });

        const text = await res.text();
        if (!res.ok) {
          throw new Error(`Embeddings request failed (${res.status}) at ${url}: ${text.replace(/\s+/g, ' ').slice(0, 300)}`);
        }

        let json;
        try {
          json = JSON.parse(text);
        } catch {
          throw new Error(`Embeddings endpoint returned non-JSON at ${url}: ${text.slice(0, 200)}`);
        }
        if (!json.data) throw new Error(`Embeddings response had no data array at ${url}`);

        const sorted = [...json.data].sort((a, b) => a.index - b.index);
        vectors.push(...sorted.map((d) => d.embedding));
      }

      return vectors;
    },
  };
}
