# Contributing

Thanks for helping improve Verboo Code Desktop.

## Project Status

This is an independent, non-official desktop build. Contributions should preserve that distinction in copy, UI, and documentation.

## Local Setup

```bash
npm install
npm run tauri:dev
```

Before submitting changes:

```bash
npm run build:renderer
deno check --config supabase/functions/feedback/deno.json supabase/functions/feedback/index.ts
deno lint --config supabase/functions/feedback/deno.json supabase/functions/feedback/index.ts
```

## Contribution Guidelines

- Keep changes focused and small.
- Do not commit generated build output.
- Do not commit real secrets or local credentials.
- Keep user-facing text clear about risky permissions and independent-build status.
- Prefer existing app patterns over adding new frameworks or abstractions.

## Feedback Backend

The feedback backend lives in `supabase/functions/feedback` and writes to the table created by `supabase/migrations/20260630221150_create_feedback_reports.sql`.

The app must keep `SUPABASE_SERVICE_ROLE_KEY` out of the desktop app (Tauri/Rust) code. The service role belongs only in Supabase Edge Function runtime configuration.
