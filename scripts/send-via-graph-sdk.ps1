# Send the 9 rendered Uber-receipt seed emails into the signed-in user's own
# inbox via the Microsoft Graph PowerShell SDK (which supports the Mail.Send
# delegated scope, unlike the Azure CLI app).
#
#   Connect-MgGraph -Scopes "Mail.Send" -UseDeviceCode
#   .\scripts\send-via-graph-sdk.ps1            # sends to the signed-in user
#   .\scripts\send-via-graph-sdk.ps1 -To someone@example.com
#
# Re-render the receipts first with:  npm run seed-inbox -- --out
# Cleanup later: search your mailbox for "WTP-DEMO-SEED", select all, delete.
param([string]$To = "")

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$dataPath = Join-Path $root "server\data\captured\uber-receipts.json"
$outDir = Join-Path $root "scripts\seed-output"

$ctx = Get-MgContext
if (-not $ctx) { throw "Not connected. Run: Connect-MgGraph -Scopes 'Mail.Send'" }
if (-not $To) { $To = $ctx.Account }
if (-not $To) {
  throw "Could not determine the recipient automatically (common when signed in with a personal account). " +
        "Re-run and pass the WORK mailbox WorkIQ reads, e.g.:  .\scripts\send-via-graph-sdk.ps1 -To you@example.com"
}

$data = Get-Content $dataPath -Raw | ConvertFrom-Json
$sent = 0
foreach ($ride in $data.rides) {
  $htmlPath = Join-Path $outDir "$($ride.id).html"
  if (-not (Test-Path $htmlPath)) { Write-Host "skip $($ride.id): no rendered HTML (run npm run seed-inbox -- --out)"; continue }
  $subject = if ($ride.sourceEmail.subject) { $ride.sourceEmail.subject } else { "Your $($ride.date) trip with Uber" }
  $html = Get-Content $htmlPath -Raw
  $payload = @{
    message = @{
      subject      = $subject
      body         = @{ contentType = "HTML"; content = $html }
      toRecipients = @(@{ emailAddress = @{ address = $To } })
    }
    saveToSentItems = $true
  } | ConvertTo-Json -Depth 12
  Invoke-MgGraphRequest -Method POST -Uri "https://graph.microsoft.com/v1.0/me/sendMail" -Body $payload -ContentType "application/json"
  $sent++
  Write-Host "sent ($sent): $subject  ->  $To"
  Start-Sleep -Milliseconds 400
}
Write-Host "`nDone. Seeded $sent Uber receipts to $To. Remove later by searching 'WTP-DEMO-SEED'."
