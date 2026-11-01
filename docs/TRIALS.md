# Trial offers

The single-workspace and bulk payment dialogs support the original no-card offer and the two explicitly selected presets (`script33`, `script33_v2`). Bulk actions send each selected workspace ID; they never substitute another workspace or automatically retry with a different offer after refusal.

The payment-based presets request Business for 14 days, with possible renewal at 24 USD/month per workspace. They require an authorized payment method, the real billing country, a manual renewal-consent checkbox and confirmation. A successful response requires Notion to confirm `trialing`; a generic HTTP 200 is not sufficient.

## Private prefills

Do not put personal payment references into source, Vite environment variables or public JavaScript bundles. Optional prefills are served by `GET /admin/subscribe/trial-defaults` only to a logged-in account whose normalized username matches `NOTION_TRIAL_DEFAULTS_OWNER`. Other accounts receive no defaults; unauthenticated and auth-disabled requests are denied. Responses are not cached. Manual edits are not overwritten by a delayed defaults response, and consent is never prechecked.

Configure these server environment variables in a private, untracked environment file:

- `NOTION_TRIAL_DEFAULTS_OWNER`: dashboard username allowed to see these prefills.
- `NOTION_TRIAL_PAYMENT_METHOD_ID`: the owner's authorized `pm_...` reference.
- `NOTION_TRIAL_BILLING_COUNTRY`: the owner's real two-letter billing country.

Leave the variables unset to keep inputs empty and use manual entry. The same configuration may be supplied privately to a local Windows process. Never commit the environment file or account/configuration data.

## Verification

Run `go test ./...` and `npm run build` in `web`. Tests cover preset payloads, workspace selection, explicit trial confirmation, validation and private-default authorization. Do not use a production subscription activation as a deployment health check.
