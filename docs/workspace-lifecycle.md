# Permanent workspace/account removal

- Account removal (including Hide all Free and Monthly cleanup) waits for server success and deletes all matching account files and pool entries, not just a browser row.
- Removed credentials are irreversibly excluded using a SHA-256 digest. Excluded credentials cannot run discovery or be silently reimported.
- Browser workspace caches are retired and deleted on dashboard startup. F5 starts from an empty list and reads the server; there is no fallback to old cached workspace records.
- A session-only lifecycle filter prevents stale refresh responses from restoring removed accounts or spaces.
- Once Notion accepts a workspace deletion task, its ID is durably excluded before the completion poll. It is filtered BEFORE subscription, quota, MCP and overage enrichment, and excluded from autopay. Task failure is reported separately from permanent removal from the application.
- If the deleted workspace was the account's primary, the account is repointed to a remaining space. If none remain, the account is removed. If remaining-space discovery temporarily fails, deleted primary metadata is cleared and later server discovery repairs the primary.
- Unknown subscription plans are not guessed to be Free.
- `workspace-exclusions.json` beside the accounts directory contains ONLY excluded IDs and credential hashes, not names, balances, email addresses or raw credentials. This small exclusion ledger is required to prevent stale Notion results from bringing items back after a browser/server restart. It must not be committed or deleted during deployment.
- Updates and deletion of account files share one lock to prevent an in-flight background save from recreating a deleted file.
- Already-started network requests may finish; later scans exclude removed items. The application's forget action does not erase Notion data unless the user chose an actual Notion workspace-deletion action.

Regression tests: `go test ./...` includes restart persistence, duplicate-account removal, stale saves, primary replacement, last-space cleanup, write-error handling and autopay cleanup. Browser fixtures additionally check old-cache retirement, stale refresh replies, failed server deletion, Hide all Free, queued workspace deletion and F5. Tests use synthetic accounts only and do not delete live Notion data.
