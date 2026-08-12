# RifaPIX

Conferência de PIX + amortização para vendas de rifas.

## Modos

1. **Local** (padrão sem env): senha no navegador + `localStorage`
2. **Nuvem** (com Supabase): Auth + Postgres + cobrança PIX + webhook de baixa automática

App online (estático): https://andrerostirolla.github.io/rifa-pix/

## Subir o banco (Supabase)

1. Crie um projeto em https://supabase.com/dashboard
2. SQL Editor → rode o arquivo `supabase/migrations/20260812000000_init.sql`
3. Settings → API: copie URL e `anon` key
4. Crie `.env` (ou secrets no host):

```bash
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
```

5. Deploy das Edge Functions:

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

Body mínimo:

```json
{
  "txid": "rifa...",
  "amount": 30,
  "payerName": "Maria Souza",
  "paidAt": "2026-08-12T12:00:00Z"
}
```

## Fluxo de baixa automática

1. Crie rifa + venda no app (modo nuvem)
2. Clique **Gerar PIX** (cria cobrança com `txid` único)
3. Cliente paga o PIX
4. PSP chama o webhook → sistema cria `pix_payments` e amortiza a venda
5. Enquanto o PSP não está ligado, use **Simular pagamento** na aba Cobranças

## Rodar local

```bash
npm install
cp .env.example .env   # se for usar Supabase
npm run dev
```

Abra `http://localhost:5173/rifa-pix/`.

## CSV de PIX

```csv
Data;Valor;Nome;TXID
11/08/2026;30,00;Maria Souza;PIX-MARIA-30
```
