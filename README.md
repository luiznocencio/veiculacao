# Verificador de Veiculação de Banners

Confere automaticamente se os comprovantes em PDF de cada site cobrem todos os dias do mês selecionado, com o banner correto no ar e a data legível — usando visão computacional (OpenAI `gpt-4o-mini`) por trás de uma função serverless.

## Arquitetura

- `index.html` — frontend estático (sem build), roda no navegador: upload de PDFs/imagens de referência, renderização de páginas via PDF.js, grade de resultado por site.
- `api/analyze.js` — função serverless da Vercel. Recebe as imagens do frontend, chama a OpenAI com a chave guardada em `OPENAI_API_KEY` (variável de ambiente do servidor) e devolve o resultado já processado. A chave nunca é exposta ao navegador.

## Deploy (primeira vez)

1. Crie um repositório **vazio** no GitHub (sem README/.gitignore automático).
2. `git remote add origin <url-do-repo>` e `git push -u origin main`.
3. No dashboard da [Vercel](https://vercel.com): **New Project → Import Git Repository** → selecione este repositório → **Framework Preset: Other** → **Deploy**.
4. **Settings → Environment Variables** → adicione `OPENAI_API_KEY` com sua chave da OpenAI (marque Production, Preview e Development).
5. Se já existir um deployment anterior a essa configuração, vá em **Deployments** → **Redeploy** para a variável ser aplicada.

## Atualizações

Qualquer `git push` na branch principal gera automaticamente um novo deploy em produção. Pushes em outras branches geram Preview Deployments (URLs de teste independentes, já com a env var aplicada).

## Uso

Acesse a URL do deploy, selecione mês/ano, suba as imagens de referência do banner e os PDFs de comprovação (até 20), e clique em "Analisar veiculação". A grade de dias por site mostra verde (ok), amarelo (banner não encontrado), vermelho (dia faltando) e cinza (ainda processando).
