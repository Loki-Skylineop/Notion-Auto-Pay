package proxy

import (
	"log"
	"net"
	"os/exec"
	"runtime"
	"strings"
	"sync"
)

// lanFirewallRuleName is the display name of the temporary inbound rule this
// process owns. It is deliberately distinctive: startup deletes any rule with
// this name before adding a fresh one, so a crash or a Task Manager kill that
// skipped the cleanup cannot leave the port open forever.
const lanFirewallRuleName = "Notion Auto-Pay LAN (temporary)"

// virtualAdapterHints are substrings of interface names belonging to
// hypervisor, container and VPN adapters. Their addresses are real but
// unreachable from a phone, so offering them as "open this on your phone"
// links would only send the user chasing a dead address.
var virtualAdapterHints = []string{
	"vmware", "vmnet", "virtualbox", "vethernet", "hyper-v",
	"loopback", "wsl", "docker", "tailscale", "zerotier",
}

// LanAddresses returns the IPv4 addresses of this machine that another device
// on the same network has a realistic chance of reaching.
func LanAddresses() []string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	out := []string{}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		if isVirtualAdapter(iface.Name) {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ipNet, ok := addr.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipNet.IP.To4()
			if ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
				continue
			}
			out = append(out, ip.String())
		}
	}
	return out
}

func isVirtualAdapter(name string) bool {
	lower := strings.ToLower(name)
	for _, hint := range virtualAdapterHints {
		if strings.Contains(lower, hint) {
			return true
		}
	}
	return false
}

// EnableLanAccess opens port in Windows Firewall for the local subnet and
// returns the function that closes it again.
//
// The rule is scoped to remoteip=LocalSubnet, so it stays limited to the home
// network even if this machine later joins a public Wi-Fi, and it is created
// per run rather than permanently: the caller is expected to invoke the
// returned closer on Ctrl+C and on console close, which is what keeps the
// dashboard from staying reachable after the window is gone.
//
// Every failure path is soft. Without administrator rights netsh simply
// refuses, and the server then behaves exactly as before - reachable on
// localhost, invisible to the rest of the network.
func EnableLanAccess(port string) func() {
	noop := func() {}
	if runtime.GOOS != "windows" {
		return noop
	}

	// A previous run that was killed instead of closed may have left its rule
	// behind; delete first so duplicates cannot pile up under one name.
	runNetshFirewall("delete", "rule", "name="+lanFirewallRuleName)

	out, err := runNetshFirewall(
		"add", "rule",
		"name="+lanFirewallRuleName,
		"dir=in",
		"action=allow",
		"protocol=TCP",
		"localport="+port,
		"remoteip=LocalSubnet",
		"profile=any",
	)
	if err != nil {
		log.Printf("[lan] could not open port %s in Windows Firewall: %v", port, err)
		if msg := strings.TrimSpace(out); msg != "" {
			log.Printf("[lan] netsh: %s", truncate(msg, 200))
		}
		log.Printf("[lan] other devices will not reach this server; run build.bat as administrator to allow it")
		return noop
	}

	log.Printf("[lan] port %s opened for the local network only, until this window closes", port)

	var once sync.Once
	return func() {
		once.Do(func() {
			if _, err := runNetshFirewall("delete", "rule", "name="+lanFirewallRuleName); err != nil {
				log.Printf("[lan] could not remove the firewall rule: %v", err)
				log.Printf("[lan] remove it by hand: netsh advfirewall firewall delete rule name=%q", lanFirewallRuleName)
				return
			}
			log.Printf("[lan] firewall rule removed, port %s is closed to the network again", port)
		})
	}
}

// runNetshFirewall runs one "netsh advfirewall firewall ..." command and
// returns its combined output for logging.
func runNetshFirewall(args ...string) (string, error) {
	full := make([]string, 0, len(args)+2)
	full = append(full, "advfirewall", "firewall")
	full = append(full, args...)
	raw, err := exec.Command("netsh", full...).CombinedOutput()
	return string(raw), err
}
