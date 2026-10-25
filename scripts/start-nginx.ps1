$ErrorActionPreference = "Stop"

$NGINX_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $NGINX_DIR

# Ensure required dirs exist
foreach ($dir in @("logs", "temp")) {
    if (!(Test-Path ".\$dir")) {
        New-Item -ItemType Directory -Path ".\$dir" | Out-Null
    }
}

# Stop a leftover nginx from THIS folder only; other projects' nginx stay up.
Get-Process nginx -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($NGINX_DIR, [System.StringComparison]::OrdinalIgnoreCase) } |
    Stop-Process -Force

# IMPORTANT: -g "daemon off;" keeps nginx attached to *this* PowerShell
# process. Without it, nginx forks into the background and escapes Tilt's
# process tree — making `ym down` unable to stop it. We want it to live and
# die with Tilt's local_resource.
& .\nginx.exe -g "daemon off;"
