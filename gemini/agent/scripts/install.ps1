param(
    [Parameter(Mandatory=$true)]
    [string]$token,

    [Parameter(Mandatory=$true)]
    [string]$master
)

$ErrorActionPreference = "Stop"

# Derive HTTP base URL from WS URL
# e.g. wss://host/ws/agent -> https://host
$baseUrl = $master
if ($baseUrl -match "^wss://") {
    $baseUrl = $baseUrl -replace "^wss://", "https://"
} elseif ($baseUrl -match "^ws://") {
    $baseUrl = $baseUrl -replace "^ws://", "http://"
}
$baseUrl = $baseUrl -replace "/ws/agent$", ""

Write-Host "[Nexus] Base URL: $baseUrl"

# Determine install dir
$installDir = "C:\NexusAgent"
$binPath = $installDir + "\nexus-agent.exe"
$oldBinPath = $binPath + ".old"
$binUrl = $baseUrl + "/downloads/nexus-agent-windows-amd64.exe"

Write-Host "[Nexus] Creating directory: $installDir"
if (!(Test-Path -Path $installDir)) {
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
}

# --- FILE-LOCK WORKAROUND ---
$svc = Get-Service -Name "nexus-agent" -ErrorAction SilentlyContinue
if ($svc) {
    Write-Host "[Nexus] Stopping existing service..."
    Stop-Service -Name "nexus-agent" -Force -ErrorAction SilentlyContinue
    # Give it a second to release the file
    Start-Sleep -Seconds 2
}

if (Test-Path -Path $binPath) {
    Write-Host "[Nexus] File in use protection: Renaming current binary..."
    Remove-Item -Path $oldBinPath -ErrorAction SilentlyContinue
    Move-Item -Path $binPath -Destination $oldBinPath -Force -ErrorAction SilentlyContinue
}

Write-Host "[Nexus] Downloading agent from: $binUrl"
Invoke-WebRequest -UseBasicParsing -Uri $binUrl -OutFile $binPath

Write-Host "[Nexus] Enrolling agent..."
$enrollUrl = $baseUrl + "/api/v1/agent/enroll"
$headers = @{
    "Authorization" = "Bearer " + $token
    "Content-Type"  = "application/json"
}

# The permanent agent token returned by enrollment is a long-lived JWT that the
# agent uses for all WebSocket connections. Fall back to the short-lived enrollment
# token if the call fails so the agent can at least run until it expires.
$agentToken = $token
try {
    $enrollResp = Invoke-RestMethod -Uri $enrollUrl -Method Post -Headers $headers -ErrorAction Stop
    if ($enrollResp.data.nodeToken) {
        $agentToken = $enrollResp.data.nodeToken
        Write-Host "[Nexus] Enrollment successful. Permanent token obtained."
    } else {
        Write-Host "[Nexus] Enrollment succeeded but no token returned; using enrollment token."
    }
} catch {
    Write-Host "[Nexus] Enrollment note: " + $_.Exception.Message
}

Write-Host "[Nexus] Cleaning up existing service (if any)..."
Start-Process -FilePath $binPath -ArgumentList "-service uninstall" -Wait -NoNewWindow -ErrorAction SilentlyContinue

Write-Host "[Nexus] Installing as Windows service..."
$installArgs = "-service install -master """ + $master + """ -token """ + $agentToken + """"
Start-Process -FilePath $binPath -ArgumentList $installArgs -Wait -NoNewWindow

Write-Host "[Nexus] Starting service..."
Start-Process -FilePath $binPath -ArgumentList "-service start" -Wait -NoNewWindow

Write-Host "[Nexus] Done! Agent is running."
Write-Host "[Nexus] Check status in Windows Services (services.msc) or Event Viewer."
