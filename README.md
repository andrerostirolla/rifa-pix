# RifaPIX

Sistema web para **conferência de PIX** nas vendas de rifas e **amortização** dos saldos em aberto.

## Online

Após o deploy do GitHub Pages:

https://andrerostirolla.github.io/rifa-pix/

## O que faz

- Login com senha do organizador (proteção local no navegador)
- Cadastro de rifas, vendas e PIX
- Importação de extrato PIX via CSV
- Amortização manual e sugestões automáticas
- Backup/restauração em JSON

Os dados ficam no `localStorage` do navegador (por aparelho). Use **Baixar backup** para levar de um PC para outro.

## Rodar no PC

```bash
npm install
npm run dev
```

Abra `http://localhost:5173/rifa-pix/`.

## CSV de PIX

Exemplo:

```csv
Data;Valor;Nome;TXID
11/08/2026;30,00;Maria Souza;PIX-MARIA-30
```

Cabeçalhos aceitos: Data, Valor, Nome/Pagador/Descrição, TXID, End-to-end.
