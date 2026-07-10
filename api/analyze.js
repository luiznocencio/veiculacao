// api/analyze.js — função serverless da Vercel (Node.js, sem dependências externas).
//
// Papel: leitura da DATA de captura de uma página de comprovação.
//
// A detecção do banner NÃO é feita aqui, por decisão baseada em evidência: em controles
// negativos (páginas do portal sem o banner) o modelo respondia "encontrado" e inventava
// a justificativa. Quem decide sobre o banner é o casamento de template no cliente, que
// é determinístico e devolve um score auditável.

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL_ID = 'gpt-4o-mini';
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 600;
const FUNCTION_BUDGET_MS = 24000; // margem de segurança sob o maxDuration:30 do vercel.json
const MAX_INLINE_WAIT_MS = 4000;  // só retenta na própria invocação se a espera indicada for curta

const SYSTEM_PROMPT = `Você recebe a imagem de uma página de comprovação de veiculação
publicitária. Ela contém a captura de tela de um site, às vezes embutida em um
documento timbrado da própria empresa (com logotipo, assinatura, carimbo e uma
data de emissão no rodapé).

Sua única tarefa é identificar a data em que a captura de tela foi feita.

Ordem de prioridade das evidências, todas avaliadas SOMENTE dentro da captura
de tela do site, nunca no timbrado ao redor:
1. Relógio do sistema ou timestamp de captura. Em capturas de desktop Windows
   ele fica no CANTO INFERIOR DIREITO da barra de tarefas, com a hora em cima e
   a data logo abaixo (ex: "11:55" sobre "18/06/2026"). Se existir, use SEMPRE
   essa data, mesmo que haja outras datas na página.
2. Se não houver relógio, use a data de publicação da matéria mais recente
   visível dentro da captura (byline, "publicado em", ou a data no caminho da
   URL na barra de endereços, ex: ".../2026/06/02/...").
3. Se não houver nenhuma das duas, use null.

A data de emissão do documento timbrado (ex: "MACEIÓ | 08 DE JUL DE 2026")
NUNCA deve ser usada.

Responda com:
- clock_date_text: transcrição LITERAL da data do relógio, exatamente como está
  escrita, com o ano completo de quatro dígitos. Não inclua a hora. null se não houver.
- article_date_text: transcrição LITERAL da data da matéria mais recente. null se não houver.
- notes: uma frase curta em português dizendo onde cada data foi vista.

NÃO converta nem reformate as datas — apenas copie os caracteres que você enxerga.
Se uma data estiver borrada demais para leitura segura, use null naquele campo:
uma data confiantemente errada é pior para a auditoria do que uma pendência.

Responda APENAS com um JSON válido, sem markdown, sem texto extra, no formato:
{"clock_date_text":"03/07/2026","article_date_text":"2026/07/03","notes":"..."}

Se a imagem não contiver nenhuma captura de site reconhecível, responda
{"clock_date_text":null,"article_date_text":null,"notes":"..."}.`;

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

// headers x-ratelimit-reset-* da OpenAI vêm como duração: "6m0s", "1s", "250ms"
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

const MONTH_NAMES_PT = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'
];

function buildAnalysisText(period) {
  let text = 'Identifique a data da captura desta página de comprovação, seguindo exatamente as instruções do system prompt.';
  if (period) {
    const monthName = MONTH_NAMES_PT[period.month - 1];
    text += ` Contexto de auditoria: o período em verificação é ${monthName} de ${period.year}. ` +
      'Use este contexto APENAS para conferir a plausibilidade do ano lido — capturas de comprovação ' +
      `são recentes, então um ano como ${period.year - 20} é quase certamente leitura errada de ${period.year}. ` +
      'NUNCA invente uma data que não esteja visível; se a data legível indicar claramente outro mês ou ano, ' +
      'reporte exatamente o que está escrito.';
  }
  return text;
}

function buildRequestBody(pageImage, period) {
  return {
    model: MODEL_ID,
    max_tokens: 600,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:${pageImage.mediaType};base64,${pageImage.base64}` }
          },
          { type: 'text', text: buildAnalysisText(period) }
        ]
      }
    ]
  };
}

function parseModelJson(rawText) {
  let text = (rawText || '').trim();
  text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Resposta sem JSON reconhecível');
  return JSON.parse(text.slice(start, end + 1));
}

function isoOrNull(year, month, day) {
  if (!(day >= 1 && day <= 31) || !(month >= 1 && month <= 12)) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// A conversão fica em código, não no modelo: ele lê os dígitos bem, mas erra a
// conversão estruturada (ex: "01/06/2026" virando "2026-01-01") e às vezes trunca
// o ano ("11/06"). fallbackYear (o ano auditado) só é usado quando falta o ano.
function dateTextToIso(dateText, fallbackYear) {
  if (!dateText) return null;
  const t = String(dateText).trim().toLowerCase();

  // formato de URL/ISO com ano na frente: 2026/06/02, 2026-06-02
  let m = /(\d{4})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{1,2})/.exec(t);
  if (m) return isoOrNull(Number(m[1]), Number(m[2]), Number(m[3]));

  // formato brasileiro DD/MM/AAAA (com hora opcional depois)
  m = /(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{2,4})/.exec(t);
  if (m) {
    let year = Number(m[3]);
    if (year < 100) year += 2000;
    return isoOrNull(year, Number(m[2]), Number(m[1]));
  }

  // formato por extenso: "1 de junho de 2026"
  m = /(\d{1,2})\s*(?:º\s*)?de\s+([a-zç]+)(?:\s+de)?\s+(\d{4})/.exec(t);
  if (m) {
    const month = MONTH_NAMES_PT.indexOf(m[2]) + 1;
    return isoOrNull(Number(m[3]), month, Number(m[1]));
  }

  // DD/MM sem ano — o relógio do Windows às vezes é transcrito truncado ("11/06").
  // O separador exclui horas ("11:52").
  if (fallbackYear) {
    m = /(?:^|\D)(\d{1,2})\s*[\/\-.]\s*(\d{1,2})(?!\s*[\/\-.]\s*\d)/.exec(t);
    if (m) return isoOrNull(fallbackYear, Number(m[2]), Number(m[1]));
  }
  return null;
}

// Prioridade aplicada em código, não pelo modelo: o relógio vence sempre que existir.
// Quando o relógio existe mas não é conversível, NÃO caímos na data da matéria — ela
// costuma ser de notícia antiga e produziria um dia verde errado.
function resolveDate(parsed, period) {
  const fallbackYear = period ? period.year : null;
  const fromClock = dateTextToIso(parsed.clock_date_text, fallbackYear);
  if (fromClock) return { date_found: fromClock, date_source: 'relógio do sistema' };
  if (parsed.clock_date_text) {
    return {
      date_found: null,
      date_warning: `relógio do sistema detectado ("${parsed.clock_date_text}") mas ilegível/incompleto`
    };
  }
  const fromArticle = dateTextToIso(parsed.article_date_text, fallbackYear);
  if (fromArticle) return { date_found: fromArticle, date_source: 'data da matéria' };
  return { date_found: null };
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
      // Espera longa demais (ou orçamento de tempo da função quase esgotado): falha rápido
      // e devolve quanto esperar, para o cliente decidir — evita o timeout da função.
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

  const { pageImage, period } = req.body || {};
  if (!pageImage || !pageImage.base64 || !pageImage.mediaType) {
    res.status(400).json({ error: 'invalid_request', message: 'pageImage é obrigatório.' });
    return;
  }

  const validPeriod =
    period && Number.isInteger(period.month) && period.month >= 1 && period.month <= 12 &&
    Number.isInteger(period.year) && period.year >= 2000 && period.year <= 2100
      ? period
      : null;

  const body = buildRequestBody(pageImage, validPeriod);

  try {
    const upstreamRes = await callOpenAIWithRetry(apiKey, body, startedAt);
    const data = await upstreamRes.json();
    const rawText = data?.choices?.[0]?.message?.content || '';
    const parsed = parseModelJson(rawText);
    const resolved = resolveDate(parsed, validPeriod);
    res.status(200).json({
      clock_date_text: parsed.clock_date_text || null,
      article_date_text: parsed.article_date_text || null,
      notes: parsed.notes || '',
      ...resolved
    });
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
