package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"golang.org/x/net/http2"
)

func TestRequireFreeDeletionPlan(t *testing.T) {
	for _, tc := range []struct {
		plan    string
		allowed bool
	}{
		{"free", true}, {"personal", true}, {" Free ", true},
		{"", false}, {" ", false}, {"team", false}, {"plus", false},
		{"pro", false}, {"personal_pro", false}, {"business", false},
		{"enterprise", false}, {"education", false}, {"unknown", false},
	} {
		t.Run(tc.plan, func(t *testing.T) {
			if got := requireFreeDeletionPlan(tc.plan) == nil; got != tc.allowed {
				t.Fatalf("plan %q: allowed=%v, want %v", tc.plan, got, tc.allowed)
			}
		})
	}
}

// All upstream requests are routed to a local fake; never use real accounts.
func TestDeleteWorkspacesOnlyFreeGuard(t *testing.T) {
	for _, tc := range []struct {
		name     string
		response string
		status   int
		allowed  bool
	}{
		{"paid", `{"type":"business"}`, 200, false},
		{"unknown", `{}`, 200, false},
		{"lookup failure", `{"error":"failed"}`, 503, false},
		{"free", `{"type":"free"}`, 200, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var queued atomic.Int32
			upstream := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/getSubscriptionData":
					w.WriteHeader(tc.status)
					w.Write([]byte(tc.response))
				case "/enqueueTask":
					queued.Add(1)
					w.Write([]byte(`{"taskId":"test-delete-task"}`))
				case "/getTasks":
					w.Write([]byte(`{"results":[{"id":"test-delete-task","state":"success"}]}`))
				default:
					t.Errorf("unexpected upstream request: %s", r.URL.Path)
					w.WriteHeader(404)
				}
			}))
			upstream.EnableHTTP2 = true
			upstream.StartTLS()
			defer upstream.Close()
			getChromeRoundTripper() // initialize before temporarily swapping test transport
			oldTransport := chromeRoundTripperH2
			testTransport := &http2.Transport{TLSClientConfig: upstream.Client().Transport.(*http.Transport).TLSClientConfig}
			chromeRoundTripperH2 = testTransport
			defer func() { testTransport.CloseIdleConnections(); chromeRoundTripperH2 = oldTransport }()
			oldBase, oldConfig := NotionAPIBase, AppConfig
			NotionAPIBase, AppConfig = upstream.URL, DefaultConfig()
			defer func() { NotionAPIBase, AppConfig = oldBase, oldConfig }()

			req := httptest.NewRequest(http.MethodPost, "/admin/workspaces/delete", strings.NewReader(`{"token_v2":"fake-test-token","user_id":"fake-user","space_ids":["fake-space"],"only_free":true}`))
			rec := httptest.NewRecorder()
			HandleDeleteWorkspaces(NewDashboardAuth("", ""))(rec, req)
			var result DeleteWorkspacesResponse
			if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if tc.allowed {
				if queued.Load() != 1 || len(result.Deleted) != 1 || result.Deleted[0].State != "success" {
					t.Fatalf("Free deletion not completed: queued=%d result=%+v", queued.Load(), result)
				}
			} else if queued.Load() != 0 || len(result.Deleted) != 0 || result.Error == "" {
				t.Fatalf("unsafe deletion guard: queued=%d result=%+v", queued.Load(), result)
			}
		})
	}
}
