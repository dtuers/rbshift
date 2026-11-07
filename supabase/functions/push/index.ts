// Rozesílání push notifikací do telefonů. Spouští ji Database Webhook při každém novém řádku v tabulce "notif".
// Nasazení: Edge Functions -> Deploy a new function -> název "push" -> vložit kód.
// VYPNI "Verify JWT" (volá ji databáze); ochranu zajišťuje tajný klíč WEBHOOK_SECRET v hlavičce.
// Secrets (Edge Functions -> Secrets): VAPID_PUBLIC, VAPID_PRIVATE, VAPID_SUBJECT, WEBHOOK_SECRET
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@example.com",
  Deno.env.get("VAPID_PUBLIC")!,
  Deno.env.get("VAPID_PRIVATE")!,
);

Deno.serve(async (req) => {
  if (req.headers.get("x-webhook-secret") !== Deno.env.get("WEBHOOK_SECRET")) {
    return new Response("Forbidden", { status: 403 });
  }
  let p: any;
  try { p = await req.json(); } catch { return new Response("Bad request", { status: 400 }); }
  const rec = p?.record;
  if (p?.type !== "INSERT" || !rec?.user_id) return new Response("ignored");

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  const { data: subs } = await sb.from("push_subs").select("*").eq("user_id", rec.user_id);
  const payload = JSON.stringify({ title: String(rec.title ?? "RB SHIFT"), body: String(rec.msg ?? ""), tag: String(rec.id ?? "") });

  await Promise.all((subs ?? []).map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 86400, urgency: "high" });
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        await sb.from("push_subs").delete().eq("endpoint", s.endpoint); // zařízení odhlásilo odběr
      }
    }
  }));
  return new Response("ok");
});
