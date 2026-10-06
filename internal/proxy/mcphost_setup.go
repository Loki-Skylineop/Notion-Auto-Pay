package proxy

import (
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"strings"
)

// A setup URL is a bearer credential. It is served only over HTTPS on the
// public VPS; the response is never cached and never contains the VPS root key.
func (s *MCPHostStore) setup(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		w.WriteHeader(405)
		return
	}
	// Trust forwarded HTTPS only from the local reverse proxy, never from arbitrary clients.
	remote, _, _ := net.SplitHostPort(r.RemoteAddr)
	ip := net.ParseIP(remote)
	if r.TLS == nil && !(ip != nil && ip.IsLoopback() && r.Header.Get("X-Forwarded-Proto") == "https") {
		http.Error(w, "HTTPS required for private setup script", http.StatusForbidden)
		return
	}
	token := strings.TrimPrefix(r.URL.Path, "/mcpsetup/")
	s.mu.RLock()
	var h MCPHost
	for _, x := range s.hosts {
		if mcpEqual(token, x.SetupToken) {
			h = x
			break
		}
	}
	s.mu.RUnlock()
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if h.ID == "" {
		http.NotFound(w, r)
		return
	}
	if s.sshHostKey == "" {
		http.Error(w, "MCP_SSH_HOST_KEY is not configured; use the VPS dashboard", 503)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	script := s.setupScript(h)
	_, _ = w.Write(append([]byte{0xef, 0xbb, 0xbf}, []byte(script)...))
}
func (s *MCPHostStore) setupScript(h MCPHost) string {
	// Use a per-host venv, scripts and startup task. Installing a second host
	// never upgrades or kills an unrelated Windows-MCP used by an existing agent.
	launcher := strings.NewReplacer("__AUTH__", h.AuthKey, "__SSH_HOST__", s.tunnelHost, "__REMOTE_PORT__", fmt.Sprint(h.TunnelPort)).Replace(mcpLauncher)
	known := s.tunnelHost + " " + s.sshHostKey + "\n"
	return strings.NewReplacer("__SUB__", h.Sub, "__PRIVATE_B64__", base64.StdEncoding.EncodeToString([]byte(h.PrivateKey)), "__KNOWN_B64__", base64.StdEncoding.EncodeToString([]byte(known)), "__LAUNCH_B64__", base64.StdEncoding.EncodeToString([]byte(launcher))).Replace(mcpInstaller)
}

const mcpInstaller = `# Notion MCP host installer. This script contains a private tunnel key.
# Never share it. Rotation revokes the old setup URL, SSH key and Bearer token.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$sub = '__SUB__'
$base = Join-Path $env:USERPROFILE ('.windows-mcp-hosts\' + $sub)
New-Item -ItemType Directory -Force -Path $base | Out-Null
# Stop only this host's previous supervisor/children before replacing its keys.
$state = Join-Path $base 'processes.json'
if (Test-Path $state) {
    try {
        $old = Get-Content $state -Raw | ConvertFrom-Json
        foreach ($oldPid in @($old.tunnel, $old.server, $old.supervisor)) {
            if (-not $oldPid -or $oldPid -eq $PID) { continue }
            $proc = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$oldPid) -ErrorAction SilentlyContinue
            if ($proc -and (($proc.ExecutablePath -and $proc.ExecutablePath.StartsWith($base,[StringComparison]::OrdinalIgnoreCase)) -or ($proc.CommandLine -and $proc.CommandLine.IndexOf($base,[StringComparison]::OrdinalIgnoreCase) -ge 0))) {
                Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
            }
        }
    } catch { Write-Host 'Previous process state unavailable; inspect this host logs if its port stays occupied.' }
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $base /inheritance:r /grant:r ($identity + ':(OI)(CI)F') | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cannot secure the MCP host directory' }
$uv = Join-Path $env:USERPROFILE '.local\bin\uv.exe'
if (-not (Test-Path $uv)) { $c = Get-Command uv -ErrorAction SilentlyContinue; if ($c) { $uv = $c.Source } }
if (-not (Test-Path $uv)) {
    Write-Host '[1/4] Installing uv'
    Invoke-RestMethod https://astral.sh/uv/install.ps1 | Invoke-Expression
    $uv = Join-Path $env:USERPROFILE '.local\bin\uv.exe'
}
if (-not (Test-Path $uv)) { throw 'uv installation failed' }
Write-Host '[2/4] Installing windows-mcp in an isolated environment'
$venv = Join-Path $base 'venv'
& $uv venv --python 3.13 $venv
if ($LASTEXITCODE -ne 0) { throw 'uv venv failed' }
& $uv pip install --python (Join-Path $venv 'Scripts\python.exe') windows-mcp
if ($LASTEXITCODE -ne 0) { throw 'windows-mcp installation failed' }
$ssh = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
if (-not (Test-Path $ssh)) { $c = Get-Command ssh -ErrorAction SilentlyContinue; if ($c) { $ssh = $c.Source } else { throw 'Install the Windows OpenSSH Client optional feature first' } }
Write-Host '[3/4] Saving restricted tunnel keys and startup scripts'
$key = Join-Path $base 'tunnel_key'
[IO.File]::WriteAllBytes($key, [Convert]::FromBase64String('__PRIVATE_B64__'))
& icacls.exe $key /inheritance:r /grant:r ($identity + ':(F)') | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cannot secure SSH key' }
[IO.File]::WriteAllBytes((Join-Path $base 'known_hosts'), [Convert]::FromBase64String('__KNOWN_B64__'))
$launch = Join-Path $base 'start-mcp.ps1'
$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__LAUNCH_B64__'))
[IO.File]::WriteAllText($launch,$text,(New-Object Text.UTF8Encoding($true)))
$run = 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $launch + '"'
$taskName = 'Notion MCP ' + $sub
try {
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $launch + '"')
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
    $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    Remove-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $taskName -ErrorAction SilentlyContinue
} catch {
    Write-Host 'Scheduled tasks unavailable: using per-user login startup instead.'
    New-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $taskName -Value $run -PropertyType String -Force | Out-Null
}
$bat = Join-Path ([Environment]::GetFolderPath('Desktop')) ('Start-MCP-' + $sub + '.bat')
[IO.File]::WriteAllText($bat,('@echo off' + [Environment]::NewLine + $run + [Environment]::NewLine),[Text.Encoding]::ASCII)
Write-Host '[4/4] Starting server and reverse SSH tunnel'
Start-Process powershell.exe -ArgumentList ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $launch + '"')
Write-Host ('Ready. Host: ' + $sub + '. Check its status in the MCP tab.')
Write-Host ('Logs: ' + $base)
`
const mcpLauncher = `# Per-host supervisor: only stops child processes it started.
$ErrorActionPreference = 'Stop'
$base = $PSScriptRoot
$lock = New-Object Threading.Mutex($false,('Local\NotionMCP-' + (Split-Path $base -Leaf)))
if (-not $lock.WaitOne(0)) { exit }
$exe = Join-Path $base 'venv\Scripts\windows-mcp.exe'
$ssh = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
if (-not (Test-Path $ssh)) { $ssh = (Get-Command ssh).Source }
$server = $null
$tunnel = $null
$port = 0
# Choose a free loopback port; never expose the computer MCP on its LAN.
$l = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,0)
$l.Start(); $port = $l.LocalEndpoint.Port; $l.Stop()
try {
    while ($true) {
        if (-not $server -or $server.HasExited) {
            $server = Start-Process -FilePath $exe -ArgumentList @('serve','--transport','streamable-http','--host','127.0.0.1','--port',[string]$port,'--auth-key','__AUTH__') -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $base 'server.log') -RedirectStandardError (Join-Path $base 'server.error.log')
            Start-Sleep 3
        }
        if (-not $tunnel -or $tunnel.HasExited) {
            $args = @('-N','-T','-i',('"'+(Join-Path $base 'tunnel_key')+'"'),'-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o',('UserKnownHostsFile="'+(Join-Path $base 'known_hosts')+'"'),'-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=20','-o','ServerAliveCountMax=3','-R',('127.0.0.1:__REMOTE_PORT__:127.0.0.1:'+ $port),'mcptun@__SSH_HOST__')
            $tunnel = Start-Process -FilePath $ssh -ArgumentList $args -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $base 'tunnel.log') -RedirectStandardError (Join-Path $base 'tunnel.error.log')
        }
        @{ supervisor = $PID; server = $server.Id; tunnel = $tunnel.Id } | ConvertTo-Json | Set-Content (Join-Path $base 'processes.json') -Encoding UTF8
        Start-Sleep 10
    }
} finally {
    if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
    if ($tunnel -and -not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue }
    $lock.ReleaseMutex(); $lock.Dispose()
}
`
