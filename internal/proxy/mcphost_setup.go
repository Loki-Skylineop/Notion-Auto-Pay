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
	_, _ = w.Write([]byte(script))
}
func (s *MCPHostStore) setupScript(h MCPHost) string {
	// Use a per-host venv and foreground runner. Installing a second host
	// never upgrades or kills an unrelated Windows-MCP used by an existing agent.
	runner := strings.NewReplacer("__AUTH__", h.AuthKey, "__SSH_HOST__", s.tunnelHost, "__REMOTE_PORT__", fmt.Sprint(h.TunnelPort)).Replace(mcpForegroundRunner)
	launcher := mcpLauncher
	known := s.tunnelHost + " " + s.sshHostKey + "\n"
	return strings.NewReplacer("__SUB__", h.Sub, "__PRIVATE_B64__", base64.StdEncoding.EncodeToString([]byte(h.PrivateKey)), "__KNOWN_B64__", base64.StdEncoding.EncodeToString([]byte(known)), "__LAUNCH_B64__", base64.StdEncoding.EncodeToString([]byte(launcher)), "__RUNNER_B64__", base64.StdEncoding.EncodeToString([]byte(runner))).Replace(mcpInstaller)
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
        foreach ($oldPid in @($old.supervisor, $old.server, $old.tunnel)) {
            if (-not $oldPid -or $oldPid -eq $PID) { continue }
            $proc = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$oldPid) -ErrorAction SilentlyContinue
            if ($proc -and (($proc.ExecutablePath -and $proc.ExecutablePath.StartsWith($base,[StringComparison]::OrdinalIgnoreCase)) -or ($proc.CommandLine -and $proc.CommandLine.IndexOf($base,[StringComparison]::OrdinalIgnoreCase) -ge 0))) {
                & taskkill.exe /PID ([string]$oldPid) /T /F 2>$null | Out-Null
            }
        }
    } catch { Write-Host 'Previous process state unavailable; inspect this host logs if its port stays occupied.' }
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $base /inheritance:r /grant:r ($identity + ':(OI)(CI)F') | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cannot secure the MCP host directory' }
$venv = Join-Path $base 'venv'
$python = Join-Path $venv 'Scripts\python.exe'
$installed = $false
if (Test-Path $python) {
    try {
        & $python -c "import importlib.util,sys;sys.exit(0 if all(importlib.util.find_spec(x) for x in ('windows_mcp','win32job')) else 1)" 2>$null
        $installed = ($LASTEXITCODE -eq 0)
    } catch { $installed = $false }
}
if (-not $installed) {
    $uv = Join-Path $env:USERPROFILE '.local\bin\uv.exe'
    if (-not (Test-Path $uv)) { $c = Get-Command uv -ErrorAction SilentlyContinue; if ($c) { $uv = $c.Source } }
    if (-not (Test-Path $uv)) {
        Write-Host '[1/4] Installing uv'
        Invoke-RestMethod https://astral.sh/uv/install.ps1 | Invoke-Expression
        $uv = Join-Path $env:USERPROFILE '.local\bin\uv.exe'
    }
    if (-not (Test-Path $uv)) { throw 'uv installation failed' }
    Write-Host '[2/4] Installing missing windows-mcp dependencies'
    if (-not (Test-Path $python)) {
        & $uv venv --python 3.13 $venv
        if ($LASTEXITCODE -ne 0) { throw 'uv venv failed' }
    }
    & $uv pip install --python $python windows-mcp
    if ($LASTEXITCODE -ne 0) { throw 'windows-mcp installation failed' }
} else { Write-Host '[1-2/4] Windows-MCP already installed; reusing it (no download)' }
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
[IO.File]::WriteAllBytes((Join-Path $base 'run-mcp.py'),[Convert]::FromBase64String('__RUNNER_B64__'))
# Migrate only this host's old background startup entries to console-only operation.
$taskName = 'Notion MCP ' + $sub
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task -and ($task.Actions | Where-Object { $_.Arguments -and $_.Arguments.IndexOf($base,[StringComparison]::OrdinalIgnoreCase) -ge 0 })) {
    Disable-ScheduledTask -TaskName $taskName -ErrorAction Stop | Out-Null
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
}
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$oldRun = (Get-ItemProperty -Path $runKey -Name $taskName -ErrorAction SilentlyContinue).$taskName
if ($oldRun -and $oldRun.IndexOf($base,[StringComparison]::OrdinalIgnoreCase) -ge 0) { Remove-ItemProperty $runKey -Name $taskName -ErrorAction Stop }
$bat = Join-Path ([Environment]::GetFolderPath('Desktop')) ('Start-MCP-' + $sub + '.bat')
$run = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $launch + '"'
[IO.File]::WriteAllText($bat,('@echo off' + [Environment]::NewLine + $run + [Environment]::NewLine),[Text.Encoding]::ASCII)
Write-Host '[4/4] Running in THIS console. Ctrl+C or closing this window stops MCP and its tunnel.'
& $launch
`

const mcpLauncher = `# Foreground launch: no new PowerShell window and no login task.
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'venv\Scripts\python.exe') -u (Join-Path $PSScriptRoot 'run-mcp.py')
if ($LASTEXITCODE -ne 0) { throw ('MCP stopped with exit code ' + $LASTEXITCODE) }
`

const mcpForegroundRunner = `# Console-bound MCP and SSH tunnel. Private credentials: do not share.
import json
import os
from pathlib import Path
import shutil
import socket
import signal
import subprocess
import sys
import time
import win32api
import win32job

BASE = Path(__file__).resolve().parent
STATE = BASE / 'processes.json'

def main():
    signal.signal(signal.SIGBREAK, signal.default_int_handler)
    # Attach ourselves BEFORE creating any children. Windows 10/11 supports nested
    # jobs. Abrupt termination/console close kills this entire process tree.
    job = win32job.CreateJobObject(None, 'NotionMCPConsole-' + str(os.getpid()))
    limits = win32job.QueryInformationJobObject(job, win32job.JobObjectExtendedLimitInformation)
    limits['BasicLimitInformation']['LimitFlags'] |= win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    win32job.SetInformationJobObject(job, win32job.JobObjectExtendedLimitInformation, limits)
    win32job.AssignProcessToJobObject(job, win32api.GetCurrentProcess())
    ssh = shutil.which('ssh') or str(Path(os.environ['WINDIR']) / 'System32/OpenSSH/ssh.exe')
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    server = None
    tunnel = None
    next_tunnel = 0
    try:
        print('MCP host: ' + BASE.name + ' | Ctrl+C to stop | local port: ' + str(port), flush=True)
        server = subprocess.Popen([sys.executable, '-u', '-m', 'windows_mcp', 'serve',
            '--transport', 'streamable-http', '--host', '127.0.0.1', '--port', str(port),
            '--auth-key', '__AUTH__'], creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
        while True:
            code = server.poll()
            if code is not None:
                print('MCP server exited: ' + str(code), flush=True)
                return code or 1
            if tunnel is not None and tunnel.poll() is not None:
                print('SSH tunnel disconnected; retrying in 5 seconds.', flush=True)
                tunnel = None
                next_tunnel = time.monotonic() + 5
            if tunnel is None and time.monotonic() >= next_tunnel:
                tunnel = subprocess.Popen([ssh, '-N', '-T', '-i', str(BASE / 'tunnel_key'),
                    '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
                    '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + str(BASE / 'known_hosts'),
                    '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=20',
                    '-o', 'ServerAliveCountMax=3', '-R', '127.0.0.1:__REMOTE_PORT__:127.0.0.1:' + str(port),
                    'mcptun@__SSH_HOST__'], creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
                STATE.write_text(json.dumps({'supervisor': os.getpid(), 'server': server.pid, 'tunnel': tunnel.pid}), encoding='utf-8')
            time.sleep(0.25)
    except KeyboardInterrupt:
        print('\nStopping MCP and SSH tunnel...', flush=True)
        return 0
    finally:
        for process in (tunnel, server):
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
        STATE.unlink(missing_ok=True)
        # Keep the job alive until interpreter shutdown; explicitly closing its
        # handle while we live would kill this supervisor too.
        global _job_handle
        _job_handle = job

if __name__ == '__main__':
    sys.exit(main())
`
