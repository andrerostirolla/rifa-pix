# RifaPIX

Conferência de PIX + amortização para vendas de rifas.

## Modos

1. **Local** (padrão sem env): senha no navegador + `localStorage` (~5 MB)
2. **Nuvem** (com Supabase): mesmo app (equipe/blocos), dados no **Postgres** sincronizados

App online (estático): https://andrerostirolla.github.io/rifa-pix/

### Colocar online (acessar de qualquer lugar)

1. No Supabase → **Settings → API**, copie **Project URL** e **anon public** key  
   Projeto atual: `https://lkoumlpmkubgpjbqyipt.supabase.co`
2. No GitHub → [Secrets do repo](https://github.com/andrerostirolla/rifa-pix/settings/secrets/actions):
   - `VITE_SUPABASE_URL` = URL do projeto
   - `VITE_SUPABASE_ANON_KEY` = anon public key
3. Na pasta do projeto:

```powershell
.\scripts\deploy-online.ps1
```

4. Aguarde o workflow em [Actions](https://github.com/andrerostirolla/rifa-pix/actions) e abra https://andrerostirolla.github.io/rifa-pix/

O frontend fica no GitHub Pages; dados e login ficam no Supabase (Postgres). PIX Sicoob roda nas Edge Functions do Supabase (secrets já configurados).

## Ligar Supabase (recomendado)

### Capacidade (plano Free)

- **Database:** ~500 MB Postgres
- **Storage:** ~1 GB (depois, se formos mover comprovantes)
- **Egress:** ~5 GB/mês
- Mais do que suficiente para o estado da rifa; comprovantes em base64 incham o JSON — use com moderação

### Passo a passo

1. Crie um projeto em https://supabase.com/dashboard (Free)
2. **SQL Editor** → rode, nesta ordem:
   - `supabase/migrations/20260812000000_init.sql`
   - `supabase/migrations/20260812210000_workspaces.sql`
   - `supabase/migrations/20260812220000_workspaces_realtime.sql` (opcional)
   - `supabase/migrations/20260812230000_chat_messages.sql` (chat da equipe)
   - `supabase/migrations/20260812240000_workspace_updated_at.sql` (sync mais rápida)
3. **Authentication → Providers → Email**: e-mail/senha ativo. Em teste, pode desligar “Confirm email”
4. **Settings → API**: copie **Project URL** e **anon public** key
5. No GitHub do repo → **Settings → Secrets and variables → Actions**, crie:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
6. Push em `main` (ou *Actions → Deploy GitHub Pages → Run workflow*)

Local opcional: `cp .env.example .env` e preencha as mesmas variáveis.

### Como usar depois de ligado

- **ADM:** criar conta / entrar com e-mail e senha. No Painel aparece o **código da equipe**
- **Membro:** login → Membro → código da equipe → Buscar membros → PIN
- Dados sobem/descem da nuvem automaticamente (com cache local)
- **Chat da equipe:** botão flutuante (canto inferior esquerdo) para ADM e membros falarem no mesmo workspace
- **Atalho / instalar app:** botão **Instalar app** ou **Add atalho** (login e topo). No celular vira ícone na tela inicial; no PC, atalho/app na área de trabalho (Chrome/Edge)

## Edge Functions (PIX — Sicoob ou mock)

```bash
npx supabase login
npx supabase link --project-ref SEU_REF
npx supabase functions deploy create-pix-charge
npx supabase functions deploy pix-webhook --no-verify-jwt
npx supabase functions deploy simulate-pix-payment
```

### Ligar API Sicoob

1. Portal: https://developers.sicoob.com.br → crie o app **Pix Recebimentos**
2. Escopos: `cob.write`, `cob.read`, `pix.read`, `webhook.write`, `webhook.read`
3. Cadastre o certificado (ICP-Brasil A1) e anote o **Client ID** + sua **chave PIX**
4. No Supabase → **Edge Functions → Secrets**:

```bash
npx supabase secrets set PIX_PROVIDER=sicoob
npx supabase secrets set SICOOB_ENV=homol
npx supabase secrets set SICOOB_CLIENT_ID=seu_client_id
npx supabase secrets set SICOOB_PIX_KEY=sua-chave-pix
npx supabase secrets set SICOOB_CERT_PEM="-----BEGIN CERTIFICATE-----
...
-----END CERTIFICATE-----"
npx supabase secrets set SICOOB_KEY_PEM="-----BEGIN PRIVATE KEY-----
...
-----END PRIVATE KEY-----"
npx supabase secrets set PIX_WEBHOOK_SECRET=um-segredo-forte
```

5. Redeploy das functions depois dos secrets
6. No portal Sicoob, cadastre o webhook:

`https://SEU_REF.supabase.co/functions/v1/pix-webhook`

(Header opcional `x-webhook-secret` se você setar `PIX_WEBHOOK_REQUIRE_SECRET=1`)

**Homolog:** `SICOOB_ENV=homol`  
**Produção:** `SICOOB_ENV=prod` + certificado da conta PJ

Sem Sicoob, deixe `PIX_PROVIDER=mock` (QR demo) e use **Simular pagamento**.

## Equipe (ADM x membro)

- **ADM**: cadastra membros, blocos, eventos, CSV/TXID, baixas e relatórios
- **Membro**: entra com PIN, vê grade dos números e lança só os dele
- Recebimento: **dinheiro** ou **PIX** (entidade ou vendedor)

Demo local: **Carregar demo** → Carlos PIN `1234`, Fernanda PIN `5678`.

## Rodar local

```bash
npm install
cp .env.example .env   # se for usar Supabase
npm run dev
```

Abra `http://localhost:5173/rifa-pix/`.
