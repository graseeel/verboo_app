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
    const category = categoryValue(payload.category);
    const title = textValue(payload.title).slice(0, 160);
    const description = textValue(payload.description).slice(0, 8000);

    if (!category || !title || !description) {
      return json({ error: "invalid_feedback_payload" }, 400);
    }

    const diagnostics = payload.includeDiagnostics === true && isRecord(payload.diagnostics)
      ? payload.diagnostics
      : {};

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
      return json({ error: "insert_failed", details: error.message }, 500);
    }

    return json({ ok: true }, 200);
  }),
};

async function readPayload(req: Request): Promise<FeedbackPayload> {
  try {
    const value = await req.json();
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
