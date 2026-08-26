# Testa token + PUT /cob no Sicoob (mesmo mTLS .NET do webhook).
# Uso: .\scripts\test-sicoob-cob.ps1

param(
  [string]$ClientId = '79dda30f-d70f-4ff7-bd74-79509ea137d2',
  [string]$PixKey = '93136803191',
  [decimal]$Amount = 0.01
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root
$certPem = Join-Path $root 'sicoob-cert.pem'
$keyPem = Join-Path $root 'sicoob-key.pem'
$openssl = 'C:\Program Files\Git\mingw64\bin\openssl.exe'
$env:OPENSSL_MODULES = 'C:\Program Files\Git\mingw64\lib\ossl-modules'

if (-not (Test-Path $certPem) -or -not (Test-Path $keyPem)) {
  throw 'Falta sicoob-cert.pem / sicoob-key.pem'
}

$tmpP12 = Join-Path $env:TEMP ("sicoob-cob-{0}.p12" -f [guid]::NewGuid().ToString('N'))
$p12Pass = 't' + ([guid]::NewGuid().ToString('N').Substring(0, 12))
$null = & $openssl pkcs12 -export -in $certPem -inkey $keyPem -out $tmpP12 -passout "pass:$p12Pass" -name sicoob 2>&1
if ($LASTEXITCODE -ne 0) { throw 'Falha ao montar P12' }

$flags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable -bor
  [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::UserKeySet
$cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($tmpP12, $p12Pass, $flags)
$handler = [System.Net.Http.HttpClientHandler]::new()
[void]$handler.ClientCertificates.Add($cert)
$handler.SslProtocols = [System.Security.Authentication.SslProtocols]::Tls12
$http = [System.Net.Http.HttpClient]::new($handler)
$http.Timeout = [TimeSpan]::FromSeconds(60)

function Send-Req {
  param(
    [string]$Method,
    [string]$Url,
    [string]$Body = $null,
    [string]$ContentType = 'application/json',
    [hashtable]$Headers = @{}
  )
  $req = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($Method), $Url)
  foreach ($k in $Headers.Keys) { [void]$req.Headers.TryAddWithoutValidation($k, [string]$Headers[$k]) }
  if ($Body -and $Method -notin @('GET','HEAD','DELETE')) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Body)
    $content = [System.Net.Http.ByteArrayContent]::new($bytes)
    $content.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse($ContentType)
    $req.Content = $content
    Write-Host "Body ($($bytes.Length) bytes): $Body"
  }
  $res = $http.SendAsync($req).GetAwaiter().GetResult()
  $text = $res.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  return @{ Code = [int]$res.StatusCode; Body = $text }
}

try {
  Write-Host "Cert: $($cert.Subject)"
  $scope = 'cob.write cob.read pix.read webhook.write webhook.read'
  $form = "grant_type=client_credentials&client_id=$([uri]::EscapeDataString($ClientId))&scope=$([uri]::EscapeDataString($scope))"
  $tok = Send-Req -Method 'POST' -Url 'https://auth.sicoob.com.br/auth/realms/cooperado/protocol/openid-connect/token' -Body $form -ContentType 'application/x-www-form-urlencoded'
  Write-Host "Token HTTP $($tok.Code)"
  if ($tok.Code -ne 200) { throw $tok.Body }
  $access = ($tok.Body | ConvertFrom-Json).access_token

  $txid = ('rifa' + ([guid]::NewGuid().ToString('N'))).Substring(0, 32)
  $amountStr = $Amount.ToString('0.00', [Globalization.CultureInfo]::InvariantCulture)
  $payload = "{`"calendario`":{`"expiracao`":1800},`"valor`":{`"original`":`"$amountStr`"},`"chave`":`"$PixKey`",`"solicitacaoPagador`":`"RifaPIX teste`"}"

  $bases = @(
    'https://api.sicoob.com.br/pix/api/v2',
    'https://apis.sicoob.com.br/cooperado/pix/api/v2'
  )

  foreach ($base in $bases) {
    $url = "$base/cob/$txid"
    Write-Host ''
    Write-Host "PUT $url"
    $r = Send-Req -Method 'PUT' -Url $url -Body $payload -ContentType 'application/json' -Headers @{
      Authorization = "Bearer $access"
      client_id = $ClientId
      Accept = 'application/json'
    }
    Write-Host "HTTP $($r.Code)"
    Write-Host $r.Body
    if ($r.Code -in 200, 201) {
      Write-Host ''
      Write-Host 'COB OK neste host. Use esta base na Edge Function.'
      break
    }
  }
}
finally {
  Remove-Item $tmpP12 -Force -ErrorAction SilentlyContinue
  $http.Dispose()
}
