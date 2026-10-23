# Dynasty HQ dashboard reminders

This owner service implements email and Web Push for Build with Alex. The browser explicitly verifies its account email or connects a browser subscription, then enables a daily or weekly reminder. The scheduler works while the app is closed. Reminders ask the owner to review a saved view; score/injury conditions and cross-device dashboard sync are outside this release.

## Deployment scope

Only these two new functions are deployed:

- `fw-dashboard-reminders`: authenticated channel setup and schedule management; public confirmation/one-click email unsubscribe.
- `fw-dashboard-reminder-worker`: scheduler-secret-protected delivery worker.

Both use their own authorization inside the handler (`verify_jwt=false` supports the existing app JWT convention). The API validates the app session against the authoritative account/session version. The worker requires a constant-time-checked dedicated secret. New tables and RPCs are service-role-only, with row-level security and account-deletion cascades. No existing account, AI, password-reset, or game functions need deployment.

Apply `supabase/migrations/20261023010000_dashboard_reminders.sql` transactionally and record its migration version. Configure the new secrets, deploy both named functions, then activate `supabase/dashboard-reminder-scheduler.sql`. The scheduler replaces only its own `dhq-dashboard-reminders` job. Store its worker secret in Supabase Vault as well as function secrets. Never put credentials in this repository or release reports.

Required function configuration:

- Existing `RESEND_API_KEY` and a verified sender, default `Dynasty HQ <noreply@dhqfootball.com>`; override with `DASHBOARD_REMINDER_FROM`.
- `DASHBOARD_REMINDER_VAPID_PUBLIC_KEY`, `DASHBOARD_REMINDER_VAPID_PRIVATE_KEY`, `DASHBOARD_REMINDER_VAPID_SUBJECT`.
- `DASHBOARD_REMINDER_WORKER_SECRET` with the same value in Vault.

The health row becomes fresh when the worker completes. Channel readiness requires fresh health and configured delivery credentials. Email-provider authorization failures remain blocked until the relevant configuration changes; do not claim delivery success from the health row alone.

## Delivery behavior

Email opt-in uses a 15-minute, six-digit challenge, rate limits and five attempts. The current database email is authoritative. Email changes invalidate its verification; opt-out pauses email reminders. Push endpoints are restricted to supported public push providers and bind to an account, device and approved app base URL. Logout disconnects browser notifications; a worker binding prevents another signed-in account seeing private notification contents.

Daily/weekly recurrence uses IANA time zones and local wall-clock time. Spring gaps use the first valid instant that day; fall overlaps use the first occurrence once. The worker claims a bounded batch with two-minute leases, rechecks the current reminder and recipient before sending, and retries at most five times within six hours. Old missed occurrences are skipped. Completed delivery records and operation receipts are retained 30 days. An already in-flight provider request can finish after pause; future queued sends recheck state.

Email retries retain the same Resend idempotency key. Web Push uses a stable topic/tag with `renotify:false`; delivery is bounded at-least-once, not exactly-once. Provider acceptance does not establish inbox or operating-system display. Dead push subscriptions are disabled and their schedules paused. The notification worker only handles push; it does not take over app fetch caching.

Email links open production at `https://c2-football.github.io/WarRoom/`. Push links preserve the approved originating app base, including the sandbox. A dashboard layout remains local to its browser.

## Tests

- `node tests/dashboard-reminders-backend.cjs`: real PostgreSQL-compatible schema/RPC behavior using PGlite.
- `node tests/dashboard-reminders-endpoints.cjs`: actual API handler, PGlite and mocked email provider.
- `node tests/dashboard-reminders-worker.cjs`: actual worker handler with mocked encryption and provider transport.
- Deno type-check both new entry points before deployment.

Hosted deployment, downloaded source equality, scheduler execution and real delivery evidence are recorded separately in the release evidence directory. Local tests do not prove live delivery.
