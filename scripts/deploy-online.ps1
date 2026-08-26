# Publica o RifaPIX no GitHub Pages (app online + Supabase).
# Rode na pasta do projeto:  .\scripts\deploy-online.ps1

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root

$git = 'C:\Program Files\Git\bin\git.exe'
if (-not (Test-Path $git)) {
  Write-Error 'Git nao encontrado. Instale Git for Windows: https://git-scm.com/download/win'
}

$repoUrl = 'https://github.com/andrerostirolla/rifa-pix.git'
$appUrl = 'https://andrerostirolla.github.io/rifa-pix/'
$supabaseUrl = 'https://lkoumlpmkubgpjbqyipt.supabase.co'

Write-Host ''
Write-Host '=== RifaPIX online (GitHub Pages + Supabase) ==='
Write-Host ''
Write-Host "URL do app (depois do deploy): $appUrl"
Write-Host ''

# --- 1) Secrets no GitHub (obrigatorio para ligar ao banco) ---
Write-Host 'PASSO 1 — Secrets no GitHub (Actions)'
Write-Host '  Abra: https://github.com/andrerostirolla/rifa-pix/settings/secrets/actions'
Write-Host '  Crie ou atualize:'
Write-Host "    VITE_SUPABASE_URL = $supabaseUrl"
Write-Host '    VITE_SUPABASE_ANON_KEY = (anon public do Supabase)'
Write-Host '  Supabase API: https://supabase.com/dashboard/project/lkoumlpmkubgpjbqyipt/settings/api'
Write-Host ''
$secretsOk = Read-Host 'Ja configurou os 2 secrets no GitHub? (s/n)'
if ($secretsOk -notmatch '^s') {
  Start-Process 'https://github.com/andrerostirolla/rifa-pix/settings/secrets/actions'
  Start-Process 'https://supabase.com/dashboard/project/lkoumlpmkubgpjbqyipt/settings/api'
  Write-Host 'Configure os secrets e rode este script de novo.'
  exit 0
}

# --- 2) Git init / remote ---
if (-not (Test-Path (Join-Path $root '.git'))) {
  Write-Host 'Inicializando git...'
  & $git init -b main
}

$remotes = & $git remote 2>$null
if ($remotes -notcontains 'origin') {
  & $git remote add origin $repoUrl
} else {
  $current = (& $git remote get-url origin 2>$null)
  if ($current -ne $repoUrl) {
    Write-Host "Remote origin atual: $current"
    $fix = Read-Host "Trocar para $repoUrl ? (s/n)"
    if ($fix -match '^s') { & $git remote set-url origin $repoUrl }
  }
}

# --- 3) Commit ---
& $git add -A
$status = & $git status --porcelain
if ($status) {
  & $git commit -m "$( @'
Deploy: integracao Sicoob PIX e scripts de certificado.

'@ )"
} else {
  Write-Host 'Nenhuma alteracao local para commitar.'
}

# --- 4) Push ---
Write-Host ''
Write-Host 'Enviando para GitHub (pode pedir login)...'
& $git pull origin main --rebase 2>$null
& $git push -u origin main

Write-Host ''
Write-Host 'PASSO 3 — Disparar deploy'
Write-Host '  Se o push funcionou, o GitHub Actions publica automaticamente.'
Write-Host '  Acompanhe: https://github.com/andrerostirolla/rifa-pix/actions'
Write-Host ''
Write-Host "Quando terminar (1-2 min), abra: $appUrl"
Write-Host ''
Start-Process 'https://github.com/andrerostirolla/rifa-pix/actions'
