# Feedback via Supabase

The app sends feedback to `VERBOO_FEEDBACK_ENDPOINT` with `VERBOO_FEEDBACK_PUBLIC_KEY`.
Use the Supabase `publishable` key for this value. The older
`VERBOO_FEEDBACK_ANON_KEY` variable is still accepted as a compatibility fallback,
but new deployments should use `VERBOO_FEEDBACK_PUBLIC_KEY`.

If Supabase is unavailable or not configured, the app opens a prefilled `mailto:`
fallback to `grasel.moura05@gmail.com`.

## Security

- Never put `SUPABASE_SERVICE_ROLE_KEY` in the Electron app.
- The service role must stay only in the Supabase Edge Function runtime.
- The `public.verboo_desktop_feedback` table has RLS enabled and no grants for `anon` or `authenticated`.
- The `supabase/functions/feedback` function writes through `ctx.supabaseAdmin`.

## Setup

1. Apply the migration in `supabase/migrations`.
2. Deploy the `feedback` function.
3. Configure the app environment:

```bash
VERBOO_FEEDBACK_ENDPOINT=https://<project-ref>.supabase.co/functions/v1/feedback
VERBOO_FEEDBACK_PUBLIC_KEY=<supabase-publishable-key>
```

## Smoke Test

```bash
curl -X POST "$VERBOO_FEEDBACK_ENDPOINT" \
  -H "authorization: Bearer $VERBOO_FEEDBACK_PUBLIC_KEY" \
  -H "apikey: $VERBOO_FEEDBACK_PUBLIC_KEY" \
  -H "content-type: application/json" \
  --data '{
    "category": "bug",
    "title": "Feedback smoke test",
    "description": "Smoke test from Verboo Code Desktop.",
    "contact": "setup@local",
    "includeDiagnostics": true,
    "diagnostics": {
      "source": "setup-smoke-test"
    }
  }'
```

Expected response:

```json
{"ok":true}
```
