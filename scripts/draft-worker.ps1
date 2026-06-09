# =============================================================================
#   WorkIQ Trip Planner - DRAFT WORKER
#
#   The admin policy blocks programmatic *sending*, but saving a draft is fine.
#   This worker holds an authenticated Microsoft Graph token (Mail.ReadWrite)
#   and turns the app's "Send with WorkIQ Tool" action into a real draft in your
#   mailbox. Run it once in a visible terminal and leave it running:
#
#       npm run draft-worker
#
#   It signs you in once via a single device code (open the URL, enter the code),
#   then watches a small filesystem queue the server writes to. The server itself
#   never needs Graph credentials. Ctrl+C to stop.
#
#   NOTE: auth is a hand-rolled OAuth2 device-code flow (Invoke-RestMethod) using
#   the public "Microsoft Graph Command Line Tools" client. We do this instead of
#   Connect-MgGraph -UseDeviceCode because, in an embedded terminal, the SDK emits
#   TWO competing codes (WAM + device) and polls the wrong one, so sign-in always
#   times out. Rolling our own gives exactly one code and a real ~15-min window.
# =============================================================================
param([string]$To = "")

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$queue = Join-Path $root "server\data\outbox\draft-queue"
New-Item -ItemType Directory -Force -Path $queue | Out-Null
$heartbeat = Join-Path $queue ".worker.alive"

# Public first-party client id for "Microsoft Graph Command Line Tools".
$ClientId = "14d82eec-204b-4c2f-b7e8-296a70dab67e"
$Tenant   = "common"   # routes both work and personal (live.com) accounts
$Scope    = "https://graph.microsoft.com/Mail.ReadWrite offline_access"
$Authority = "https://login.microsoftonline.com/$Tenant/oauth2/v2.0"

$script:AccessToken = $null
$script:RefreshToken = $null
$script:TokenExpiresAt = [datetime]::MinValue
$script:Account = "(unknown)"

function Invoke-DeviceCodeSignIn {
  $dc = Invoke-RestMethod -Method POST -Uri "$Authority/devicecode" -Body @{
    client_id = $ClientId; scope = $Scope
  }
  Write-Host ""
  Write-Host "  Sign in to save drafts:" -ForegroundColor Cyan
  Write-Host ("  1. Open  {0}" -f $dc.verification_uri) -ForegroundColor White
  Write-Host ("  2. Enter code  {0}" -f $dc.user_code) -ForegroundColor Yellow
  Write-Host ("  (code valid for {0} min)" -f [int]($dc.expires_in / 60)) -ForegroundColor DarkGray
  Write-Host ""

  $interval = [int]$dc.interval
  if ($interval -lt 5) { $interval = 5 }
  $deadline = (Get-Date).AddSeconds([int]$dc.expires_in)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds $interval
    try {
      $tok = Invoke-RestMethod -Method POST -Uri "$Authority/token" -Body @{
        grant_type = "urn:ietf:params:oauth:grant-type:device_code"
        client_id  = $ClientId
        device_code = $dc.device_code
      }
      $script:AccessToken = $tok.access_token
      $script:RefreshToken = $tok.refresh_token
      $script:TokenExpiresAt = (Get-Date).AddSeconds([int]$tok.expires_in - 120)
      return $true
    }
    catch {
      $body = $_.ErrorDetails.Message
      if ($body -and ($body -match "authorization_pending")) { continue }
      if ($body -and ($body -match "slow_down")) { $interval += 5; continue }
      # Any other error (declined/expired/blocked) is terminal for this attempt.
      $msg = if ($body) { $body } else { $_.Exception.Message }
      Write-Host ("  Sign-in failed: {0}" -f $msg) -ForegroundColor Red
      return $false
    }
  }
  Write-Host "  Sign-in timed out." -ForegroundColor Red
  return $false
}

function Update-AccessToken {
  # Refresh silently when the access token is close to expiry.
  if ((Get-Date) -lt $script:TokenExpiresAt) { return }
  if (-not $script:RefreshToken) { throw "No refresh token; restart the worker to sign in again." }
  $tok = Invoke-RestMethod -Method POST -Uri "$Authority/token" -Body @{
    grant_type = "refresh_token"; client_id = $ClientId
    refresh_token = $script:RefreshToken; scope = $Scope
  }
  $script:AccessToken = $tok.access_token
  if ($tok.refresh_token) { $script:RefreshToken = $tok.refresh_token }
  $script:TokenExpiresAt = (Get-Date).AddSeconds([int]$tok.expires_in - 120)
}

function Invoke-Graph([string]$Method, [string]$Uri, $Body) {
  Update-AccessToken
  $headers = @{ Authorization = "Bearer $($script:AccessToken)" }
  if ($null -ne $Body) {
    return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $headers -Body $Body -ContentType "application/json"
  }
  return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $headers
}

if (-not (Invoke-DeviceCodeSignIn)) { exit 1 }

# Confirm who we are (and surface the mailbox the drafts will land in).
try {
  $me = Invoke-Graph "GET" "https://graph.microsoft.com/v1.0/me?`$select=userPrincipalName,mail" $null
  $script:Account = if ($me.mail) { $me.mail } else { $me.userPrincipalName }
}
catch { }

Write-Host ("Draft worker ready as {0}." -f $script:Account) -ForegroundColor Green
Write-Host ("Watching {0}" -f $queue) -ForegroundColor DarkGray
Write-Host "Leave this running during the demo. Press Ctrl+C to stop.`n"

while ($true) {
  # Heartbeat so the server can tell at a glance whether the worker is up.
  Set-Content -Path $heartbeat -Value (Get-Date -Format o) -Encoding UTF8

  $reqs = @(Get-ChildItem -Path $queue -Filter "*.req.json" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime)
  foreach ($req in $reqs) {
    $id = $req.BaseName -replace '\.req$', ''
    $resPath = Join-Path $queue "$id.res.json"
    try {
      $job = Get-Content $req.FullName -Raw | ConvertFrom-Json
      $html = Get-Content $job.htmlFile -Raw
      $recipient = if ($job.to) { $job.to } else { $script:Account }
      $payload = @{
        subject      = $job.subject
        body         = @{ contentType = "HTML"; content = $html }
        toRecipients = @(@{ emailAddress = @{ address = $recipient } })
      } | ConvertTo-Json -Depth 12
      # POST /me/messages creates the message in the Drafts folder (it is NOT sent).
      $draft = Invoke-Graph "POST" "https://graph.microsoft.com/v1.0/me/messages" $payload
      @{ ok = $true; draftId = $draft.id; webLink = $draft.webLink } | ConvertTo-Json | Set-Content -Path $resPath -Encoding UTF8
      Write-Host ("draft saved: '{0}'  ->  {1}" -f $job.subject, $recipient) -ForegroundColor Green
    }
    catch {
      $emsg = if ($_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
      @{ ok = $false; error = $emsg } | ConvertTo-Json | Set-Content -Path $resPath -Encoding UTF8
      Write-Host ("draft FAILED: {0}" -f $emsg) -ForegroundColor Red
    }
    finally {
      Remove-Item $req.FullName -Force -ErrorAction SilentlyContinue
    }
  }
  Start-Sleep -Milliseconds 500
}
