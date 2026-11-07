// Registrace zaměstnance přes jednorázový QR kód.
// Nasazení: Edge Functions -> Deploy a new function -> název "register" -> vložit kód.
// Vypni "Verify JWT" (volá ji nepřihlášený uživatel, kód QR je ověření).
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const hex = (s: string) => [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, "0")).join("");
const emailOf = (u: string) => "u" + hex(u) + "@rbshift.example.com";
const NAMEOK = /^[\p{L} .-]{2,30}$/u;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Metoda není povolena" }, 405);
  let b: any;
  try { b = await req.json(); } catch { return json({ error: "Neplatný požadavek" }, 400); }

  const name = String(b.name ?? "").trim().replace(/\s+/g, " ");
  const password = String(b.password ?? "");
  const code = String(b.code ?? "").trim().toUpperCase();
  if (!NAMEOK.test(name)) return json({ error: "Jméno: 2–30 znaků, písmena a mezery" }, 400);
  if (password.length < 8) return json({ error: "Heslo musí mít alespoň 8 znaků" }, 400);
  if (!/^[A-Z0-9]{8}$/.test(code)) return json({ error: "Neplatný QR kód" }, 400);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  const username = norm(name);

  const { data: ex } = await sb.from("profiles").select("id").eq("username", username).maybeSingle();
  if (ex) return json({ error: "Toto jméno už existuje" }, 409);

  // „zabrat“ kód atomicky, aby ho nešlo použít dvakrát
  const { data: claimed } = await sb.from("qr").update({ used: true, by_name: name })
    .eq("code", code).eq("used", false).select("team, pos, leader").maybeSingle();
  if (!claimed) return json({ error: "Neplatný nebo už použitý QR kód" }, 400);

  const { data: cu, error: ce } = await sb.auth.admin.createUser({
    email: emailOf(username), password, email_confirm: true,
  });
  if (ce || !cu.user) {
    await sb.from("qr").update({ used: false, by_name: null }).eq("code", code);
    return json({ error: "Účet se nepodařilo vytvořit" }, 400);
  }
  const pos = claimed.pos || "Operátor";
  const { error: pe } = await sb.from("profiles").insert({
    id: cu.user.id, username, name, role: "emp", team: claimed.team, pos,
  });
  if (pe) {
    await sb.auth.admin.deleteUser(cu.user.id);
    await sb.from("qr").update({ used: false, by_name: null }).eq("code", code);
    return json({ error: "Profil se nepodařilo vytvořit" }, 400);
  }
  await sb.from("notif").insert([
    { user_id: cu.user.id, title: "Vítejte v RB SHIFT", msg: `Byl vám přidělen tým ${claimed.team} · ${pos}` },
    { user_id: claimed.leader, title: "Nový zaměstnanec", msg: `${name} (${pos}) se připojil do týmu ${claimed.team}` },
  ]);
  return json({ ok: true });
});
