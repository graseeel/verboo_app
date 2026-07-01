import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

type FeedbackPayload = {
  category?: unknown;
  title?: unknown;
  description?: unknown;
  contact?: unknown;
  includeDiagnostics?: unknown;
  diagnostics?: unknown;
  appVersion?: unknown;
  platform?: unknown;
  systemVersion?: unknown;
};

type FeedbackInsertClient = {
  from(table: string): {
    insert(row: Record<string, unknown>): PromiseLike<{ error: { message: string } | null }>;
  };
};

type FeedbackCountClient = {
  from(table: string): {
    select(columns: string, opts: { count: "exact"; head: true }): {
      gte(column: string, value: string): PromiseLike<{ count: number | null; error: { message: string } | null }>;
    };
  };
};

// 32KB is generous headroom over the real payload shape (title<=160, description<=8000, contact<=160, small diagnostics object).
const MAX_BODY_BYTES = 32 * 1024;
// Real diagnostics payloads from the app are a few hundred chars; this is generous headroom.
const MAX_DIAGNOSTICS_CHARS = 4000;

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

export default {
  fetch: withSupabase({ auth: ["publishable", "secret"] }, async (req, ctx) => {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    if (req.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405);
    }

    const payload = await readPayload(req);
    if (payload instanceof Response) return payload;

    const category = categoryValue(payload.category);
    const title = textValue(payload.title).slice(0, 160);
    const description = textValue(payload.description).slice(0, 8000);

    if (!category || !title || !description) {
      return json({ error: "invalid_feedback_payload" }, 400);
    }

    const hasDiagnostics = payload.includeDiagnostics === true && isRecord(payload.diagnostics);
    if (hasDiagnostics && JSON.stringify(payload.diagnostics).length > MAX_DIAGNOSTICS_CHARS) {
      return json({ error: "diagnostics_too_large" }, 400);
    }
    const diagnostics = hasDiagnostics ? payload.diagnostics : {};

    // Coarse, global throttle across all callers (not per-IP — there's no IP column on this table).
    try {
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const countClient = ctx.supabaseAdmin as unknown as FeedbackCountClient;
      const { count, error: countError } = await countClient
        .from("verboo_desktop_feedback")
        .select("*", { count: "exact", head: true })
        .gte("created_at", tenMinutesAgo);
      if (countError) throw new Error(countError.message);
      if ((count ?? 0) >= 50) {
        return json({ error: "rate_limited" }, 429);
      }
    } catch (rateLimitError) {
      console.error("feedback rate limit check failed:", rateLimitError);
    }

    const feedbackClient = ctx.supabaseAdmin as unknown as FeedbackInsertClient;
    const { error } = await feedbackClient
      .from("verboo_desktop_feedback")
      .insert({
        category,
        title,
        description,
        contact: optionalText(payload.contact),
        app_version: optionalText(payload.appVersion),
        platform: optionalText(payload.platform),
        system_version: optionalText(payload.systemVersion),
        diagnostics,
        source: "desktop",
      });

    if (error) {
      console.error("feedback insert failed:", error.message);
      return json({ error: "insert_failed" }, 500);
    }

    return json({ ok: true }, 200);
  }),
};

async function readPayload(req: Request): Promise<FeedbackPayload | Response> {
  const contentLength = req.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    return json({ error: "payload_too_large" }, 413);
  }

  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) {
      return json({ error: "payload_too_large" }, 413);
    }
    const value = JSON.parse(text);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function json(body: Record<string, unknown>, status: number): Response {
  return Response.json(body, {
    status,
    headers: corsHeaders,
  });
}

function categoryValue(value: unknown): "bug" | "feedback" | "question" | undefined {
  if (value === "bug" || value === "feedback" || value === "question") return value;
  return undefined;
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalText(value: unknown): string | null {
  const text = textValue(value);
  return text ? text.slice(0, 240) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
