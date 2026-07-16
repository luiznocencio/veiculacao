// api/analyze.js — função serverless da Vercel (Node.js, sem dependências externas).
//
// Papel: leitura da DATA de captura e, sob demanda, SEGUNDA OPINIÃO sobre o banner.
//
// O casamento de template no cliente é a primeira opinião (determinística, com score
// auditável). Quando ele NÃO tem certeza, o cliente pede aqui uma segunda opinião: a
// função recebe as artes de referência e a página e responde presente/ausente/incerto.
// O prompt força o modelo a descrever antes de decidir e trata "ausente" como resposta
// legítima — foi a falta dessa instrução que, no passado, gerava "encontrado" falso.
//
// Provedor: Anthropic Claude Haiku. O gpt-4o-mini foi testado e descartado por custo de
// tokens de imagem: uma página A4 (1104x1568) consome 70.837 tokens nele — 2833 + 5667
// por tile de 512px — contra 2.308 no Haiku (largura*altura/750). Com 200k TPM na conta,
// isso dava ~3 páginas por minuto e uma tempestade de 429.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL_ID = 'claude-haiku-4-5-20251001';
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 600;
const FUNCTION_BUDGET_MS = 24000; // margem de segurança sob o maxDuration:30 do vercel.json
const MAX_INLINE_WAIT_MS = 4000;  // só retenta na própria invocação se a espera indicada for curta

// Regras de data — idênticas nos dois modos. Mantidas num só lugar para não divergirem.
const DATE_RULES = `Ordem de prioridade das evidências de DATA, todas avaliadas SOMENTE
dentro da captura de tela do site, nunca no timbrado ao redor:
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

- clock_date_text: transcrição LITERAL da data do relógio, exatamente como está
  escrita, com o ano completo de quatro dígitos. Não inclua a hora. null se não houver.
- article_date_text: transcrição LITERAL da data da matéria mais recente. null se não houver.

NÃO converta nem reformate as datas — apenas copie os caracteres que você enxerga.
Se uma data estiver borrada demais para leitura segura, use null naquele campo:
uma data confiantemente errada é pior para a auditoria do que uma pendência.`;

// Modo 1: só data. A imagem é uma página de comprovação.
const SYSTEM_PROMPT_DATE = `Você recebe a imagem de uma página de comprovação de veiculação
publicitária. Ela contém a captura de tela de um site, às vezes embutida em um
documento timbrado da própria empresa (com logotipo, assinatura, carimbo e uma
data de emissão no rodapé).

Sua única tarefa é identificar a data em que a captura de tela foi feita.

${DATE_RULES}

- notes: uma frase curta em português dizendo onde a data foi vista.

Responda APENAS com um JSON válido, sem markdown, sem texto extra, no formato:
{"clock_date_text":"03/07/2026","article_date_text":"2026/07/03","notes":"..."}

Se a imagem não contiver nenhuma captura de site reconhecível, responda
{"clock_date_text":null,"article_date_text":null,"notes":"..."}.`;

// Modo 2: segunda opinião sobre o banner + data. Vêm PRIMEIRO as artes de referência,
// DEPOIS a página. O foco é combater o "encontrado" falso: descrever antes de decidir,
// e deixar explícito que "ausente" é uma resposta correta e esperada.
const SYSTEM_PROMPT_BANNER = `Você recebe DUAS coisas: primeiro uma ou mais imagens da
ARTE DE REFERÊNCIA de um banner publicitário, e depois a imagem de uma PÁGINA DE
COMPROVAÇÃO — a captura de tela de um site, às vezes embutida num documento timbrado.

Você tem DUAS tarefas.

TAREFA 1 — O banner de referência aparece dentro da captura?
Descreva primeiro, em uma frase, o que realmente existe no topo, nas laterais e no corpo
da captura. SÓ ENTÃO decida. É comum e ESPERADO que o banner não esteja presente:
responder "nao" quando ele não está é a resposta CORRETA, nunca uma falha. Responda
"sim" apenas se você realmente vê a MESMA arte (mesmas cores, mesmo texto, mesmo logotipo)
dentro da captura. Responda "incerto" se a captura estiver cortada, borrada ou pequena
demais para ter certeza. NUNCA invente um banner que não está claramente visível.

TAREFA 2 — Qual a data da captura?
${DATE_RULES}

Responda com:
- banner_present: "sim", "nao" ou "incerto".
- banner_notes: uma frase curta dizendo o que você viu que embasa a resposta do banner.
- clock_date_text, article_date_text (regras acima).
- notes: uma frase curta dizendo onde a data foi vista.

Responda APENAS com um JSON válido, sem markdown, sem texto extra, no formato:
{"banner_present":"nao","banner_notes":"...","clock_date_text":null,"article_date_text":"2026/07/03","notes":"..."}`;

function buildSystemPrompt(askBanner) {
  return askBanner ? SYSTEM_PROMPT_BANNER : SYSTEM_PROMPT_DATE;
}

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

  // fallback: os headers de rate limit da Anthropic trazem timestamps ISO 8601,
  // não durações como os da OpenAI.
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

function buildAnalysisText(period, askBanner) {
  let text = askBanner
    ? 'As imagens acima são: primeiro a(s) arte(s) de referência do banner, e por último a página de comprovação. Faça as duas tarefas do system prompt sobre a ÚLTIMA imagem (a página).'
    : 'Identifique a data da captura desta página de comprovação, seguindo exatamente as instruções do system prompt.';
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

function buildRequestBody(pageImage, period, refs, askBanner) {
  const content = [];
  // No modo banner, as artes de referência vêm ANTES da página (o prompt conta com essa ordem).
  if (askBanner && refs.length) {
    for (const ref of refs) {
      content.push({ type: 'image', source: { type: 'base64', media_type: ref.mediaType, data: ref.base64 } });
    }
  }
  content.push({ type: 'image', source: { type: 'base64', media_type: pageImage.mediaType, data: pageImage.base64 } });
  content.push({ type: 'text', text: buildAnalysisText(period, askBanner) });

  return {
    model: MODEL_ID,
    max_tokens: 600,
    // Ler a data de um print é TRANSCRIÇÃO, não criação: queremos a mesma resposta para a
    // mesma imagem. Sem isto o default é 1.0 (amostragem), e foi medido em duas rodadas do
    // mesmo PDF: a página 8 do PI 8769 leu "2025-06-26" numa e "2025-06-05" na outra, e a
    // página 6 do Prints penedo leu "2026-06-04" e depois "2026-06-06". Dias mudando de
    // rodada para rodada destroem a confiança na auditoria.
    temperature: 0,
    // O system prompt se repete em todas as chamadas do lote: marcá-lo como cache evita
    // pagar o custo total de input em cada página. (Cada modo tem sua própria entrada.)
    system: [{ type: 'text', text: buildSystemPrompt(askBanner), cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content }]
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

// O modelo às vezes devolve a STRING "null" em vez do null do JSON. Como string é
// truthy, isso fazia o código concluir "há um relógio, mas ilegível" e recusar a data
// da matéria — descartando páginas cuja data estava perfeitamente visível.
function cleanText(value) {
  if (typeof value !== 'string') return value || null;
  const t = value.trim();
  if (!t || /^(null|none|nenhum[ao]?|n\/a|-|--)$/i.test(t)) return null;
  return t;
}

// Normaliza a opinião do banner para um vocabulário fixo, tolerando variações do modelo
// ("sim"/"yes"/"presente" → present; "nao"/"no"/"ausente" → absent; resto → uncertain).
function normalizeBannerOpinion(value) {
  const t = cleanText(value);
  if (!t) return 'uncertain';
  const s = t.toLowerCase();
  if (/^(sim|s|yes|y|presente|present|true)$/.test(s) || /\bpresent/.test(s) || /\bsim\b/.test(s)) return 'present';
  if (/^(nao|não|n|no|ausente|absent|false)$/.test(s) || /\bausent/.test(s) || /\bn[aã]o\b/.test(s)) return 'absent';
  return 'uncertain';
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
  const clockText = cleanText(parsed.clock_date_text);
  const articleText = cleanText(parsed.article_date_text);

  const fromClock = dateTextToIso(clockText, fallbackYear);
  if (fromClock) return { date_found: fromClock, date_source: 'relógio do sistema' };

  const fromArticle = dateTextToIso(articleText, fallbackYear);
  if (clockText) {
    // Relógio presente mas ilegível: a data da matéria costuma ser de notícia antiga,
    // então usá-la produziria um dia verde errado. Melhor pendência para revisão.
    return {
      date_found: null,
      date_warning: `relógio do sistema detectado ("${clockText}") mas ilegível/incompleto`
    };
  }
  if (fromArticle) return { date_found: fromArticle, date_source: 'data da matéria' };
  return { date_found: null };
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
      // Espera longa demais (ou orçamento de tempo da função quase esgotado): falha rápido
      // e devolve quanto esperar, para o cliente decidir — evita o timeout da função.
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

  const { pageImage, period, refs } = req.body || {};
  if (!pageImage || !pageImage.base64 || !pageImage.mediaType) {
    res.status(400).json({ error: 'invalid_request', message: 'pageImage é obrigatório.' });
    return;
  }

  // Só pedimos a segunda opinião quando o cliente manda artes de referência (askBanner:true
  // + refs). O cliente as omite nas páginas em que o template já tem certeza — assim a
  // maioria das chamadas segue barata, e só as duvidosas pagam os tokens das referências.
  const validRefs = Array.isArray(refs)
    ? refs.filter((r) => r && typeof r.base64 === 'string' && typeof r.mediaType === 'string').slice(0, 4)
    : [];
  const askBanner = req.body && req.body.askBanner === true && validRefs.length > 0;

  const validPeriod =
    period && Number.isInteger(period.month) && period.month >= 1 && period.month <= 12 &&
    Number.isInteger(period.year) && period.year >= 2000 && period.year <= 2100
      ? period
      : null;

  const body = buildRequestBody(pageImage, validPeriod, validRefs, askBanner);

  try {
    const upstreamRes = await callAnthropicWithRetry(apiKey, body, startedAt);
    const data = await upstreamRes.json();
    const rawText = (data.content || []).map((block) => block.text || '').join('');
    const parsed = parseModelJson(rawText);
    const resolved = resolveDate(parsed, validPeriod);
    const bannerFields = askBanner
      ? { banner_opinion: normalizeBannerOpinion(parsed.banner_present), banner_notes: cleanText(parsed.banner_notes) || '' }
      : {};
    res.status(200).json({
      clock_date_text: cleanText(parsed.clock_date_text),
      article_date_text: cleanText(parsed.article_date_text),
      notes: parsed.notes || '',
      ...bannerFields,
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
