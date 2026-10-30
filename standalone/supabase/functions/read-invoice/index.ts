// Reads an invoice photo or PDF with Claude. The API key stays here on the server, and the
// prompt is fixed here too, so a signed-in user cannot use this function for anything else.
import Anthropic from "npm:@anthropic-ai/sdk@1.2.0";
import { SCAN_PROMPT } from "./prompt.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown) => new Response(JSON.stringify(body), { headers: { ...cors, "Content-Type": "application/json" } });
const fail = (error: string) => reply({ ok: false, error });

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

function parseJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    const a = text.indexOf("{"), b = text.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(text.slice(a, b + 1));
      } catch { /* reported below */ }
    }
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return fail("invalid_request");

  // Checked here as well as at the gateway: the publishable key is public, and each call spends money.
  const authorization = req.headers.get("Authorization") ?? "";
  const who = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, {
    headers: { Authorization: authorization, apikey: req.headers.get("apikey") ?? "" },
  }).catch(() => null);
  if (!who?.ok) {
    return new Response(JSON.stringify({ ok: false, error: "session_expired" }), {
      status: 401,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  let files: { type: string; data: string }[];
  try {
    files = (await req.json()).files;
  } catch {
    return fail("image_rejected");
  }
  if (!Array.isArray(files) || !files.length || files.length > 3) return fail("image_rejected");

  const content: Anthropic.Beta.Messages.BetaContentBlockParam[] = [];
  for (const f of files) {
    if (typeof f?.data !== "string" || !f.data) return fail("image_rejected");
    if (f.type === "application/pdf") {
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: f.data } });
    } else if ((IMAGE_TYPES as readonly string[]).includes(f.type)) {
      content.push({ type: "image", source: { type: "base64", media_type: f.type as ImageType, data: f.data } });
    } else {
      return fail("image_rejected");
    }
  }
  content.push({ type: "text", text: SCAN_PROMPT });

  const client = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
  try {
    const res = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{ role: "user", content }],
    } as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming);
    if (res.stop_reason === "refusal") return fail("refused");
    if (res.stop_reason === "max_tokens") return fail("invalid_json");
    const invoice = parseJson(res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""));
    return invoice ? reply({ ok: true, invoice }) : fail("invalid_json");
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return fail("rate_limited");
    if (e instanceof Anthropic.BadRequestError) return fail("image_rejected");
    console.error(e);
    return fail("upstream_error");
  }
});
