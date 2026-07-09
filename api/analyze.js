// api/analyze.js — função serverless da Vercel (Node.js, sem dependências externas).
// Recebe { refs, pageImage } do frontend, chama a OpenAI com a chave guardada só no
// servidor, e devolve { prints: [...] } já parseado. O cliente nunca vê a chave nem o
// texto bruto do modelo.

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL_ID = 'gpt-4o-mini';
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 600;
const FUNCTION_BUDGET_MS = 24000; // margem de segurança sob o maxDuration:30 do vercel.json
const MAX_INLINE_WAIT_MS = 4000;  // só retenta na própria invocação se a espera indicada for curta

const SYSTEM_PROMPT = `Você é um auditor de veiculação de banners publicitários. Você recebe primeiro
uma ou mais imagens de referência da arte do banner (podem existir em
formatos/tamanhos diferentes, mas é sempre a mesma arte/campanha), e depois
uma imagem de uma página de PDF que pode conter um ou mais prints/capturas de
tela separadas, cada uma mostrando um site com o banner supostamente no ar,
e alguma indicação de data (pode ser um timestamp de captura, um relógio do
sistema, uma data exibida na página, etc).

Para CADA print distinto que você identificar na imagem da página, responda:
- banner_found: true se a arte do banner na imagem de referência aparece
  visivelmente no print, false caso contrário.
- date_found: a data visível no print, no formato estrito YYYY-MM-DD.
  Se não houver nenhuma data legível no print, use null.
- notes: uma frase curta em português explicando o que foi observado.

Responda APENAS com um JSON válido, sem markdown, sem texto extra,
no formato exato:
{"prints":[{"banner_found":true,"date_found":"2026-07-03","notes":"..."}]}

Se a página não tiver nenhum print reconhecível, responda {"prints":[]}.`;

class UpstreamAuthError extends Error {}
class RateLimitedError extends Error {
  constructor(message, retryAfterMs) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// aceita formatos usados pelos headers x-ratelimit-reset-* da OpenAI, ex: "6m0s", "1s", "250ms"
function parseOpenAIDuration(str) {
  if (!str) return null;
  const m = /^(?:(\d+)m)?(\d+(?:\.\d+)?)(ms|s)?$/.exec(str.trim());
  if (!m) return null;
  const minutes = m[1] ? Number(m[1]) : 0;
  const value = Number(m[2]);
  const unitMs = m[3] === 'ms' ? 1 : 1000;
  return minutes * 60000 + value * unitMs;
}

function resolveWaitMs(res, attempt) {
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) return Number(retryAfter) * 1000;

  const remReq = Number(res.headers.get('x-ratelimit-remaining-requests'));
  const remTok = Number(res.headers.get('x-ratelimit-remaining-tokens'));
  const resetReq = parseOpenAIDuration(res.headers.get('x-ratelimit-reset-requests'));
  const resetTok = parseOpenAIDuration(res.headers.get('x-ratelimit-reset-tokens'));

  const candidates = [];
  if (remReq === 0 && resetReq != null) candidates.push(resetReq);
  if (remTok === 0 && resetTok != null) candidates.push(resetTok);
  if (candidates.length) return Math.max(...candidates);

  return RETRY_BASE_DELAY_MS * (attempt + 1) + Math.floor(Math.random() * 300);
}

function buildMessages(refs, pageImage) {
  const content = [
    ...refs.map((ref) => ({
      type: 'image_url',
      image_url: { url: `data:${ref.mediaType};base64,${ref.base64}` }
    })),
    {
      type: 'image_url',
      image_url: { url: `data:${pageImage.mediaType};base64,${pageImage.base64}` }
    },
    {
      type: 'text',
      text: 'Analise esta página de comprovação de veiculação e identifique cada print presente, seguindo exatamente as instruções do system prompt.'
    }
  ];
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content }
  ];
}

function parseModelJson(rawText) {
  let text = (rawText || '').trim();
  text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Resposta sem JSON reconhecível');
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed.prints)) throw new Error('Campo "prints" ausente ou inválido');
  return parsed;
}

async function callOpenAI(apiKey, body) {
  return fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });
}

async function callOpenAIWithRetry(apiKey, body, startedAt) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res;
    try {
      res = await callOpenAI(apiKey, body);
    } catch (networkErr) {
      lastErr = new Error('Falha de rede ao contatar a OpenAI.');
      const elapsed = Date.now() - startedAt;
      if (attempt < MAX_RETRIES && elapsed + RETRY_BASE_DELAY_MS < FUNCTION_BUDGET_MS) {
        await sleep(RETRY_BASE_DELAY_MS);
        continue;
      }
      throw lastErr;
    }

    if (res.status === 401 || res.status === 403) {
      throw new UpstreamAuthError('Chave de API da OpenAI inválida, sem permissão ou sem créditos.');
    }
    if (res.ok) return res;

    if (res.status === 429 || res.status >= 500) {
      const wait = resolveWaitMs(res, attempt);
      const elapsed = Date.now() - startedAt;
      const canRetryInline =
        attempt < MAX_RETRIES && wait <= MAX_INLINE_WAIT_MS && elapsed + wait < FUNCTION_BUDGET_MS;

      if (canRetryInline) {
        await sleep(wait);
        continue;
      }
      // Espera longa demais (ou orçamento de tempo da função já quase esgotado): não vale a
      // pena tentar de novo aqui dentro. Falha rápido e devolve quanto esperar para o cliente
      // decidir — evita a função ser matada por timeout (maxDuration:30 no vercel.json).
      throw new RateLimitedError(`Falha temporária da OpenAI (status ${res.status}).`, wait);
    }

    const errBody = await res.text().catch(() => '');
    throw new Error(`Erro inesperado da OpenAI (status ${res.status}): ${errBody.slice(0, 300)}`);
  }
  throw lastErr;
}

module.exports = async function handler(req, res) {
  const startedAt = Date.now();
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed', message: 'Use POST.' });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: 'server_misconfigured',
      message: 'OPENAI_API_KEY não configurada no ambiente do servidor. Contate o administrador do projeto na Vercel.'
    });
    return;
  }

  const { refs, pageImage } = req.body || {};
  if (!Array.isArray(refs) || refs.length === 0 || !pageImage || !pageImage.base64 || !pageImage.mediaType) {
    res.status(400).json({ error: 'invalid_request', message: 'refs (array não vazio) e pageImage são obrigatórios.' });
    return;
  }

  const body = {
    model: MODEL_ID,
    max_tokens: 1000,
    response_format: { type: 'json_object' },
    messages: buildMessages(refs, pageImage)
  };

  try {
    const upstreamRes = await callOpenAIWithRetry(apiKey, body, startedAt);
    const data = await upstreamRes.json();
    const rawText = data?.choices?.[0]?.message?.content || '';
    const parsed = parseModelJson(rawText);
    res.status(200).json(parsed);
  } catch (err) {
    if (err instanceof UpstreamAuthError) {
      res.status(401).json({ error: 'invalid_api_key', message: err.message });
      return;
    }
    if (err instanceof RateLimitedError) {
      res.status(429).json({ error: 'rate_limited', message: err.message, retryAfterMs: err.retryAfterMs });
      return;
    }
    res.status(502).json({ error: 'upstream_error', message: err.message || 'Falha ao consultar o modelo.' });
  }
};
