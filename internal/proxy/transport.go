package proxy

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"sync"
	"time"

	utls "github.com/refraction-networking/utls"
	"golang.org/x/net/http2"

	"notion-manager/internal/netutil"
)

// Chrome TLS transport using uTLS to mimic Chrome's JA3/JA4 fingerprint.
// Uses http2.Transport for proper HTTP/2 support with custom TLS dial.
//
// dialChromeTLS reads AppConfig.Proxy.NotionProxy at dial time, so
// updating the global proxy via /admin/settings takes effect on the next
// connection without rebuilding the singleton. Idle pooled connections
// are torn down by RebuildChromeTransport so a flipped setting doesn't
// leak across the boundary.
var (
	chromeRoundTripperOnce sync.Once
	chromeRoundTripperH2   *http2.Transport
)

func getChromeRoundTripper() http.RoundTripper {
	chromeRoundTripperOnce.Do(func() {
		chromeRoundTripperH2 = &http2.Transport{
			DialTLSContext: func(ctx context.Context, network, addr string, _ *tls.Config) (net.Conn, error) {
				return dialChromeTLS(ctx, network, addr)
			},
			DisableCompression: true, // We set Accept-Encoding ourselves
		}
	})
	return chromeRoundTripperH2
}

// RebuildChromeTransport drops every idle pooled connection so the next
// notion request re-dials and picks up the freshly-configured upstream
// proxy. Active in-flight requests are unaffected — the http2.Transport
// will simply not lend their connections to new callers anymore.
//
// Called from /admin/settings PUT after persisting a new proxy URL.
func RebuildChromeTransport() {
	getChromeRoundTripper() // ensure init
	if chromeRoundTripperH2 != nil {
		chromeRoundTripperH2.CloseIdleConnections()
	}
	// The S3 upload transport dials through the same proxy setting, so it has
	// to forget its pooled connections too.
	if s3RoundTripper != nil {
		s3RoundTripper.CloseIdleConnections()
	}
}

func dialChromeTLS(ctx context.Context, network, addr string) (net.Conn, error) {
	// Parse host for SNI
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}

	// Honour the configured TLS dial timeout via a context deadline
	// before delegating to the shared proxy-aware dialer. The dialer
	// already enforces its own 30s connect timeout, but the project's
	// AppConfig.Timeouts.TLSDialTimeout governs the overall budget
	// (raw TCP + TLS handshake) so the caller's expectations hold
	// regardless of which path we take.
	dialCtx := ctx
	if to := AppConfig.TLSDialTimeoutDuration(); to > 0 {
		var cancel context.CancelFunc
		dialCtx, cancel = context.WithTimeout(ctx, to)
		defer cancel()
	}

	rawConn, err := netutil.DialThroughProxy(dialCtx, network, addr, AppConfig.NotionProxyURL())
	if err != nil {
		return nil, fmt.Errorf("tcp dial: %w", err)
	}

	// Create uTLS connection with Chrome fingerprint + ALPN h2
	tlsConfig := &utls.Config{
		ServerName:         host,
		InsecureSkipVerify: false,
		MinVersion:         tls.VersionTLS12,
		NextProtos:         []string{"h2", "http/1.1"},
	}

	tlsConn := utls.UClient(rawConn, tlsConfig, utls.HelloChrome_Auto)

	if err := tlsConn.HandshakeContext(dialCtx); err != nil {
		rawConn.Close()
		return nil, fmt.Errorf("tls handshake: %w", err)
	}

	return tlsConn, nil
}

// getChromeHTTPClient returns an http.Client with Chrome TLS fingerprint
func getChromeHTTPClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Transport: getChromeRoundTripper(),
		Timeout:   timeout,
	}
}

// Presigned S3 uploads must NOT use the Chrome round tripper. That one is a
// pure http2.Transport: it speaks HTTP/2 on whatever connection DialTLSContext
// hands it, without ever looking at ALPN. Notion's bucket
// (prod-files-secure.s3.us-west-2.amazonaws.com) answers presigned POSTs in
// HTTP/1.1 - the browser capture records httpVersion "HTTP/1.1" for exactly
// this request - so the HTTP/2 framer reads the plain "HTTP/1.1 204" status
// line as a frame header and fails with
//
//	http2: frame too large, note that the frame header looked like an HTTP/1.1 header
//
// Hence a separate transport with HTTP/2 disabled at every level: ALPN offers
// http/1.1 only, ForceAttemptHTTP2 is off, and TLSNextProto is a non-nil empty
// map so net/http never installs the h2 upgrade on its own.
//
// The dial still goes through netutil.DialThroughProxy with the configured
// AppConfig.Proxy.NotionProxy, so an upload leaves the machine over the same
// hop as the rest of the Notion traffic instead of leaking the real address.
var (
	s3RoundTripperOnce sync.Once
	s3RoundTripper     *http.Transport
)

func getS3RoundTripper() *http.Transport {
	s3RoundTripperOnce.Do(func() {
		s3RoundTripper = &http.Transport{
			DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
				proxyURL := ""
				if AppConfig != nil {
					proxyURL = AppConfig.NotionProxyURL()
				}
				return netutil.DialThroughProxy(ctx, network, addr, proxyURL)
			},
			TLSClientConfig: &tls.Config{
				MinVersion: tls.VersionTLS12,
				NextProtos: []string{"http/1.1"},
			},
			ForceAttemptHTTP2:     false,
			TLSNextProto:          map[string]func(authority string, c *tls.Conn) http.RoundTripper{},
			MaxIdleConns:          8,
			IdleConnTimeout:       60 * time.Second,
			TLSHandshakeTimeout:   30 * time.Second,
			ExpectContinueTimeout: 1 * time.Second,
		}
	})
	return s3RoundTripper
}

// getS3HTTPClient returns the HTTP/1.1-only client used for presigned S3 POSTs.
func getS3HTTPClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Transport: getS3RoundTripper(),
		Timeout:   timeout,
	}
}
