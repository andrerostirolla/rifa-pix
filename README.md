# RifaPIX

Conferência de PIX + amortização para vendas de rifas.

## Modos

1. **Local** (padrão sem env): senha no navegador + `localStorage` (~5 MB)
2. **Nuvem** (com Supabase): mesmo app (equipe/blocos), dados no **Postgres** sincronizados

App online (estático): https://andrerostirolla.github.io/rifa-pix/

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

## Edge Functions (PIX webhook — opcional)

```bash
npx supabase login
npx supabase link --project-ref SEU_REF
npx supabase secrets set PIX_WEBHOOK_SECRET=um-segredo-forte
npx supabase functions deploy create-pix-charge
npx supabase functions deploy pix-webhook --no-verify-jwt
npx supabase functions deploy simulate-pix-payment
```

Webhook URL (PSP/banco):

`https://SEU_REF.supabase.co/functions/v1/pix-webhook`

Header: `x-webhook-secret: um-segredo-forte`

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
