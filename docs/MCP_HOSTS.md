# MCP hosts — restored into the current application

The MCP tab manages self-hosted Windows computers behind reverse SSH tunnels. It is separate from AIRI API keys and the Notion workspace MCP connection controls. This is a source-level reconstruction using the surviving August deployment's JSON schema; it does not run the old application as a sidecar or roll back AIRI.

## User workflow

1. Sign into the VPS dashboard and open **MCP**.
2. Create a 3–30 character lowercase hostname and choose the permitted tools.
3. Run the displayed PowerShell command on the Windows PC you want to expose.
4. Add the displayed HTTPS `/mcp` URL and Bearer token to Notion.

The installer uses a per-host environment under `%USERPROFILE%\.windows-mcp-hosts\<host>`, binds Windows-MCP to loopback only, pins the VPS SSH host key, and runs in the SAME PowerShell console with live server/HTTP/SSH logs. Existing dependencies are reused without downloads. Ctrl+C or closing the console stops the server, its descendants and tunnel via a Windows kill-on-close job object. It creates no login task or background PowerShell window; re-running migrates this host's earlier task/HKCU Run entry to console-only operation. Multiple hosts do not share Python environments, keys, scripts or processes. It never kills another MCP installation.

Create public hosts on the VPS, not in a disconnected Windows dashboard. The Windows build contains the same UI and module but links to the central VPS for public tunnel management; creating local credentials would not install their public SSH key on the VPS.

## Access modes

- Full access: all MCP tools; arbitrary code execution is possible.
- No code: blocks direct PowerShell/Registry and unknown tool names. Mouse/keyboard, file access and app launching remain possible; **this is not a sandbox or a guarantee that code cannot execute**.
- Observation: only Snapshot, Screenshot, State/State-Tool and Wait. Other `tools/call` requests are denied by the gateway.

Dashboard access is owner-scoped; admins can manage all hosts. Public computer endpoints use their own Bearer keys, never dashboard cookies or AIRI API keys. Setup URLs contain credentials: never share them. Rotation replaces the setup token, Bearer token and SSH key, and requires reinstalling the host. Rotation does not terminate an already-running tool request or remove old PC-side files. Deleting a host removes its gateway and authorized SSH key; close its console and remove its local files to uninstall from Windows. Old foreground commands keep running until stopped; run the latest setup command again to receive launcher updates.

## Deployment

Keep these private and out of Git:

- `mcphosts.json`: compatible with the old `{ "version": 1, "hosts": [...] }` records.
- `users.json`, `accounts`, configuration files and private keys.

Environment:

- `MCP_BASE_DOMAIN`: public base domain (VPS default `31.76.119.238.nip.io`).
- `MCP_TUNNEL_HOST`: SSH address (default `31.76.119.238`).
- `MCP_SSH_HOST_KEY`: public SSH key, e.g. `ssh-ed25519 AAAA...`; required to generate a usable setup script.
- `MCP_AUTHORIZED_KEYS`: Linux defaults to `/home/mcptun/.ssh/authorized_keys`. The OS user must be able to atomically update it. Existing unrelated manual keys are preserved.

SSH tunnel user `mcptun` must permit remote forwarding to loopback only. Generated authorized keys use `restrict,port-forwarding,permitlisten="127.0.0.1:<port>",permitopen="127.0.0.1:1"`. Ports are 8300–8999. Keep them inaccessible from the internet. Caddy routes the base domain and host subdomains to the current application; long-lived MCP responses require streaming proxy support.

HTTPS is required for `/mcpsetup/`. Forwarded HTTPS is trusted only from loopback. Optional Caddy on-demand certificate authorization route: `/mcp/cert-check?domain=...`, allowing stored hosts, the base domain and the existing `most` relay.

## Validation and rollback

Run `go test ./...`, build the Vite frontend, copy `web/dist` to `internal/web/dist`, then build Windows and Linux binaries. Back up the current VPS binary, JSON data, service/drop-in and Caddyfile before deploying. Verify dashboard health, owner isolation, wrong-key denial, host create/rotate/delete, setup syntax, tool restrictions and an actual SSH/MCP handshake. Roll back the binary and configuration together if validation fails; never restore old users/accounts JSON over live data casually.
