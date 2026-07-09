// api/analyze.js — função serverless da Vercel (Node.js, sem dependências externas).
// Recebe { refs, pageImage } do frontend, chama a Anthropic (Claude) com a chave guardada
// só no servidor, e devolve { prints: [...] } já parseado. O cliente nunca vê a chave nem
// o texto bruto do modelo.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL_ID = 'claude-haiku-4-5-20251001';
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
sistema, ou a data de publicação de uma matéria/notícia visível na página).

ATENÇÃO à estrutura da página: muitas vezes o print do site vem embutido em
um documento timbrado do próprio veículo — com logotipo, cabeçalho, rodapé,
assinatura, carimbo/CNPJ e uma data de emissão do documento (ex: "MACEIÓ |
08 DE JUL DE 2026"). Essa moldura NÃO faz parte do print do site. Datas que
pertencem ao timbrado (data de emissão, data junto à assinatura, cabeçalho
ou rodapé do documento) NUNCA devem ser usadas como evidência do dia de
veiculação — considere apenas o que está DENTRO do screenshot do site.

Para CADA print distinto que você identificar na imagem da página, responda:
- banner_found: true se a arte do banner na imagem de referência aparece
  visivelmente no print, false caso contrário.
- clock_date_text: a transcrição LITERAL da data mostrada pelo relógio do
  sistema ou timestamp de captura DENTRO do print, exatamente como aparece
  escrita (ex: "18/06/2026"). DICA IMPORTANTE: em capturas de desktop
  Windows, o relógio fica no CANTO INFERIOR DIREITO da barra de tarefas,
  com a hora em cima e a data logo abaixo (ex: "11:55" sobre "18/06/2026").
  Examine esse canto com atenção máxima antes de responder. Transcreva a data
  COMPLETA, incluindo o ano com os quatro dígitos — nunca a trunque para
  "11/06". Não inclua a hora neste campo. Use null apenas se realmente não
  houver relógio/timestamp legível no print.
- article_date_text: a transcrição LITERAL da data de publicação da matéria
  mais recente visível dentro do print — byline, "publicado em", data junto
  ao título, ou data no caminho da URL da barra de endereços (ex:
  ".../2026/06/02/..." → transcreva "2026/06/02"). Se houver várias matérias
  com datas diferentes, transcreva a MAIS RECENTE. null se não houver.
- notes: uma frase curta em português explicando o que foi observado e
  onde cada data foi vista; se uma data de timbrado foi ignorada, mencione.

Regras para as transcrições:
- NÃO converta, NÃO reformate — apenas copie os caracteres que você enxerga.
- Considere apenas o que está DENTRO do screenshot do site; datas do
  documento timbrado ao redor (emissão, assinatura, rodapé) NUNCA entram
  em nenhum dos dois campos.
- Se uma data estiver borrada ou pequena demais para leitura segura, use
  null naquele campo em vez de arriscar — uma data confiantemente errada é
  pior para a auditoria do que uma pendência de revisão humana.

Responda APENAS com um JSON válido, sem markdown, sem texto extra,
no formato exato:
{"prints":[{"banner_found":true,"clock_date_text":"03/07/2026","article_date_text":"2026/07/03","notes":"..."}]}

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

function resolveWaitMs(res, attempt) {
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) return Number(retryAfter) * 1000;

  // fallback: headers de rate limit da Anthropic trazem timestamps ISO 8601, não durações
  const remReq = Number(res.headers.get('anthropic-ratelimit-requests-remaining'));
  const remTok = Number(res.headers.get('anthropic-ratelimit-tokens-remaining'));
  const resetReq = res.headers.get('anthropic-ratelimit-requests-reset');
  const resetTok = res.headers.get('anthropic-ratelimit-tokens-reset');

  const candidates = [];
  if (remReq === 0 && resetReq) candidates.push(new Date(resetReq).getTime() - Date.now());
  if (remTok === 0 && resetTok) candidates.push(new Date(resetTok).getTime() - Date.now());
  const valid = candidates.filter((ms) => Number.isFinite(ms) && ms > 0);
  if (valid.length) return Math.max(...valid);

  return RETRY_BASE_DELAY_MS * (attempt + 1) + Math.floor(Math.random() * 300);
}

const MONTH_NAMES_PT = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'
];

function buildAnalysisText(period) {
  let text = 'Analise esta página de comprovação de veiculação e identifique cada print presente, seguindo exatamente as instruções do system prompt.';
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

function buildRequestBody(refs, pageImage, period) {
  const content = [
    ...refs.map((ref, idx) => ({
      type: 'image',
      source: { type: 'base64', media_type: ref.mediaType, data: ref.base64 },
      ...(idx === refs.length - 1 ? { cache_control: { type: 'ephemeral' } } : {})
    })),
    {
      type: 'image',
      source: { type: 'base64', media_type: pageImage.mediaType, data: pageImage.base64 }
    },
    {
      type: 'text',
      text: buildAnalysisText(period)
    }
  ];
  return {
    model: MODEL_ID,
    max_tokens: 1000,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content }]
  };
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

function isoOrNull(year, month, day) {
  if (!(day >= 1 && day <= 31) || !(month >= 1 && month <= 12)) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Converte a transcrição literal da data para ISO em código. O modelo lê os dígitos bem,
// mas erra a conversão estruturada (ex: "01/06/2026" virando "2026-01-01") e às vezes
// trunca o ano ("11/06"), então a conversão é feita aqui, de forma determinística.
// fallbackYear (o ano auditado) só é usado quando a transcrição não traz ano nenhum.
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

  // formato por extenso: "1 de junho de 2026", "1º de junho 2026"
  m = /(\d{1,2})\s*(?:º\s*)?de\s+([a-zç]+)(?:\s+de)?\s+(\d{4})/.exec(t);
  if (m) {
    const month = MONTH_NAMES_PT.indexOf(m[2]) + 1;
    return isoOrNull(Number(m[3]), month, Number(m[1]));
  }

  // DD/MM sem ano — o relógio do Windows às vezes é transcrito truncado ("11/06").
  // Só reparável se soubermos o ano auditado. O separador exclui horas ("11:52").
  if (fallbackYear) {
    m = /(?:^|\D)(\d{1,2})\s*[\/\-.]\s*(\d{1,2})(?!\s*[\/\-.]\s*\d)/.exec(t);
    if (m) return isoOrNull(fallbackYear, Number(m[2]), Number(m[1]));
  }
  return null;
}

// A prioridade de evidências é aplicada AQUI, em código, e não pelo modelo:
// o relógio do sistema vence sempre que existir; a data de matéria é fallback.
// Quando o relógio existe mas não é conversível, NÃO caímos na data da matéria: ela
// costuma ser de notícia antiga ainda na página, e produziria um dia verde errado.
// Preferimos marcar a página para revisão humana (date_found null + date_warning).
function normalizePrintDates(parsed, period) {
  const fallbackYear = period ? period.year : null;
  parsed.prints.forEach((print) => {
    const fromClock = dateTextToIso(print.clock_date_text, fallbackYear);
    if (fromClock) {
      print.date_found = fromClock;
      print.date_source = 'relógio do sistema';
      return;
    }
    if (print.clock_date_text) {
      print.date_found = null;
      print.date_warning = `relógio do sistema detectado ("${print.clock_date_text}") mas ilegível/incompleto`;
      return;
    }
    const fromArticle = dateTextToIso(print.article_date_text, fallbackYear);
    if (fromArticle) {
      print.date_found = fromArticle;
      print.date_source = 'data da matéria';
      return;
    }
    print.date_found = dateTextToIso(print.date_text, fallbackYear) || null;
    if (print.date_found) print.date_source = 'data no print';
  });
  return parsed;
}

async function callAnthropic(apiKey, body) {
  return fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION
    },
    body: JSON.stringify(body)
  });
}

async function callAnthropicWithRetry(apiKey, body, startedAt) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res;
    try {
      res = await callAnthropic(apiKey, body);
    } catch (networkErr) {
      lastErr = new Error('Falha de rede ao contatar a Anthropic.');
      const elapsed = Date.now() - startedAt;
      if (attempt < MAX_RETRIES && elapsed + RETRY_BASE_DELAY_MS < FUNCTION_BUDGET_MS) {
        await sleep(RETRY_BASE_DELAY_MS);
        continue;
      }
      throw lastErr;
    }

    if (res.status === 401 || res.status === 403) {
      throw new UpstreamAuthError('Chave de API da Anthropic inválida, sem permissão ou sem créditos.');
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
      throw new RateLimitedError(`Falha temporária da Anthropic (status ${res.status}).`, wait);
    }

    const errBody = await res.text().catch(() => '');
    throw new Error(`Erro inesperado da Anthropic (status ${res.status}): ${errBody.slice(0, 300)}`);
  }
  throw lastErr;
}

module.exports = async function handler(req, res) {
  const startedAt = Date.now();
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed', message: 'Use POST.' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: 'server_misconfigured',
      message: 'ANTHROPIC_API_KEY não configurada no ambiente do servidor. Contate o administrador do projeto na Vercel.'
    });
    return;
  }

  const { refs, pageImage, period } = req.body || {};
  if (!Array.isArray(refs) || refs.length === 0 || !pageImage || !pageImage.base64 || !pageImage.mediaType) {
    res.status(400).json({ error: 'invalid_request', message: 'refs (array não vazio) e pageImage são obrigatórios.' });
    return;
  }

  // period é opcional; só é usado se vier bem formado
  const validPeriod =
    period && Number.isInteger(period.month) && period.month >= 1 && period.month <= 12 &&
    Number.isInteger(period.year) && period.year >= 2000 && period.year <= 2100
      ? period
      : null;

  const body = buildRequestBody(refs, pageImage, validPeriod);

  try {
    const upstreamRes = await callAnthropicWithRetry(apiKey, body, startedAt);
    const data = await upstreamRes.json();
    const rawText = (data.content || []).map((block) => block.text || '').join('');
    const parsed = normalizePrintDates(parseModelJson(rawText), validPeriod);
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
