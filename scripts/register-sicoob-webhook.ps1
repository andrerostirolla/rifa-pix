# Cadastra webhook PIX no Sicoob (PUT /webhook/{chave}) via mTLS.
# Usa .NET HttpClient + certificado P12 (curl/Schannel no Windows falha com Sicoob).
#
# Uso:
#   .\scripts\register-sicoob-webhook.ps1

param(
  [string]$ClientId = '79dda30f-d70f-4ff7-bd74-79509ea137d2',
  [string]$PixKey = '93136803191',
  [string]$WebhookUrl = 'https://lkoumlpmkubgpjbqyipt.supabase.co/functions/v1/pix-webhook',
  [string]$Scope = 'cob.write cob.read pix.read webhook.write webhook.read'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root

$certPem = Join-Path $root 'sicoob-cert.pem'
$keyPem = Join-Path $root 'sicoob-key.pem'
$pfxPath = Join-Path $root 'sicoob.pfx'
$openssl = 'C:\Program Files\Git\mingw64\bin\openssl.exe'
$env:OPENSSL_MODULES = 'C:\Program Files\Git\mingw64\lib\ossl-modules'

$tokenUrl = 'https://auth.sicoob.com.br/auth/realms/cooperado/protocol/openid-connect/token'
$apiBases = @(
  'https://api.sicoob.com.br/pix/api/v2',
  'https://apis.sicoob.com.br/cooperado/pix/api/v2',
  'https://apis.sisbr.com.br/cooperado/pix/api/v2'
)

$tmpP12 = Join-Path $env:TEMP ("sicoob-mtls-{0}.p12" -f [guid]::NewGuid().ToString('N'))
$p12Pass = 't' + ([guid]::NewGuid().ToString('N').Substring(0, 12))
$ownedTemp = $false

function New-MtlsClient {
  param([string]$P12, [string]$Pass)
  $flags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable -bor
    [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::MachineKeySet -bor
    [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::PersistKeySet
  try {
    $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($P12, $Pass, $flags)
  } catch {
    $flags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable -bor
      [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::UserKeySet
    $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($P12, $Pass, $flags)
  }

  $handler = [System.Net.Http.HttpClientHandler]::new()
  $handler.ClientCertificates.Add($cert) | Out-Null
  $handler.SslProtocols = [System.Security.Authentication.SslProtocols]::Tls12
  if ([enum]::GetNames([System.Security.Authentication.SslProtocols]) -contains 'Tls13') {
    $handler.SslProtocols = $handler.SslProtocols -bor [System.Security.Authentication.SslProtocols]::Tls13
  }
  $handler.CheckCertificateRevocationList = $false
  $client = [System.Net.Http.HttpClient]::new($handler)
  $client.Timeout = [TimeSpan]::FromSeconds(60)
  return @{ Client = $client; Cert = $cert; Handler = $handler }
}

function Invoke-Mtls {
  param(
    $Bundle,
    [string]$Method,
    [string]$Url,
    [hashtable]$Headers = @{},
    $Body = $null,
    [string]$ContentType = 'application/json'
  )
  $req = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($Method), $Url)
  foreach ($k in $Headers.Keys) {
    [void]$req.Headers.TryAddWithoutValidation($k, [string]$Headers[$k])
  }
  # Nao enviar body em GET/DELETE (ProtocolViolationException no .NET)
  if ($null -ne $Body -and "$Body".Length -gt 0 -and $Method -notin @('GET', 'HEAD', 'DELETE')) {
    $req.Content = [System.Net.Http.StringContent]::new([string]$Body, [Text.Encoding]::UTF8, $ContentType)
  }
  $res = $Bundle.Client.SendAsync($req).GetAwaiter().GetResult()
  $text = $res.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  return @{
    Code = [int]$res.StatusCode
    Body = $text
    Ok = $res.IsSuccessStatusCode
  }
}

try {
  if (-not (Test-Path $openssl)) {
    throw 'OpenSSL do Git nao encontrado'
  }

  if ((Test-Path $certPem) -and (Test-Path $keyPem)) {
    Write-Host 'Montando P12 temporario a partir do PEM...'
    $err = & $openssl pkcs12 -export -in $certPem -inkey $keyPem -out $tmpP12 -passout "pass:$p12Pass" -name sicoob 2>&1
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $tmpP12)) {
      throw "Falha ao criar P12: $err"
    }
    $ownedTemp = $true
  } elseif (Test-Path $pfxPath) {
    Write-Host 'Usando sicoob.pfx...'
    $pwdPlain = Read-Host 'Senha do sicoob.pfx' -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($pwdPlain)
    try { $p12Pass = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    $tmpP12 = $pfxPath
  } else {
    throw 'Falta sicoob-cert.pem/sicoob-key.pem ou sicoob.pfx'
  }

  Write-Host ''
  Write-Host '=== Sicoob: obter token (mTLS via .NET) ==='
  Write-Host "Client ID : $ClientId"
  Write-Host "Chave PIX : $PixKey"
  Write-Host "Webhook   : $WebhookUrl"
  Write-Host "Cert      : $($tmpP12)"
  Write-Host ''

  $bundle = New-MtlsClient -P12 $tmpP12 -Pass $p12Pass
  Write-Host "Certificado carregado: $($bundle.Cert.Subject)"
  Write-Host "Valido ate: $($bundle.Cert.NotAfter)"

  $form = "grant_type=client_credentials&client_id=$([uri]::EscapeDataString($ClientId))&scope=$([uri]::EscapeDataString($Scope))"
  Write-Host "Token: $tokenUrl"
  $tok = Invoke-Mtls -Bundle $bundle -Method 'POST' -Url $tokenUrl -Body $form -ContentType 'application/x-www-form-urlencoded'

  if (-not $tok.Ok -or $tok.Body -notmatch 'access_token') {
    throw "Token falhou HTTP $($tok.Code): $($tok.Body)"
  }

  $accessToken = ($tok.Body | ConvertFrom-Json).access_token
  Write-Host "OK token (HTTP $($tok.Code))"
  Write-Host ''
  Write-Host '=== PUT /webhook/{chave} ==='

  $payload = (@{ webhookUrl = $WebhookUrl } | ConvertTo-Json -Compress)
  $ok = $false
  $last = ''

  foreach ($base in $apiBases) {
    $url = "$base/webhook/$([uri]::EscapeDataString($PixKey))"
    Write-Host "Tentando: $url"
    $r = Invoke-Mtls -Bundle $bundle -Method 'PUT' -Url $url -Body $payload -ContentType 'application/json' -Headers @{
      Authorization = "Bearer $accessToken"
      client_id = $ClientId
      Accept = 'application/json'
    }
    Write-Host "HTTP $($r.Code)"
    if ($r.Body) { Write-Host $r.Body }
    if ($r.Code -in 200, 201, 204) {
      $ok = $true
      Write-Host ''
      Write-Host 'Webhook cadastrado.'
      Write-Host "Obs: Sicoob pode chamar: $WebhookUrl/pix"
      break
    }
    $last = "HTTP $($r.Code): $($r.Body)"
  }

  if (-not $ok) { throw "Falha ao cadastrar webhook. $last" }

  Write-Host ''
  Write-Host 'Consulta (GET):'
  $getUrl = "$($apiBases[0])/webhook/$([uri]::EscapeDataString($PixKey))"
  $g = Invoke-Mtls -Bundle $bundle -Method 'GET' -Url $getUrl -Headers @{
    Authorization = "Bearer $accessToken"
    client_id = $ClientId
    Accept = 'application/json'
  }
  Write-Host "HTTP $($g.Code)"
  if ($g.Body) { Write-Host $g.Body }
  Write-Host ''
}
finally {
  if ($ownedTemp -and (Test-Path $tmpP12)) {
    Remove-Item $tmpP12 -Force -ErrorAction SilentlyContinue
  }
}
