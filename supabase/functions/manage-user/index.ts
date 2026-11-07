// Správa účtů: vytvoření vedoucího, úprava a smazání uživatele.
// Nasazení: Edge Functions -> Deploy a new function -> název "manage-user" -> vložit kód.
// Nechej zapnuté "Verify JWT". Oprávnění se kontrolují znovu uvnitř.
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const TEAMS = ["Němček", "Bártl", "Růžička", "Sellner"];
const POS = ["Operátor", "Seřizovač", "Zásobovač"];
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const hex = (s: string) => [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, "0")).join("");
const emailOf = (u: string) => "u" + hex(u) + "@rbshift.example.com";
const NAMEOK = /^[\p{L} .-]{2,30}$/u;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Metoda není povolena" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const svc = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: au } = await svc.auth.getUser(jwt);
  if (!au?.user) return json({ error: "Nepřihlášen" }, 401);
  const { data: me } = await svc.from("profiles").select("*").eq("id", au.user.id).maybeSingle();
  if (!me) return json({ error: "Nepřihlášen" }, 401);

  let b: any;
  try { b = await req.json(); } catch { return json({ error: "Neplatný požadavek" }, 400); }
  const action = String(b.action ?? "");

  // ---- smazání (admin kohokoli kromě sebe, vedoucí jen zaměstnance svého týmu)
  async function removeUser(t: any) {
    const { data: offers } = await svc.from("docs").select("id,data").eq("kind", "offer");
    for (const o of offers ?? []) {
      if (o.data?.apps && t.username in o.data.apps) {
        delete o.data.apps[t.username];
        await svc.from("docs").update({ data: o.data }).eq("kind", "offer").eq("id", o.id);
      }
    }
    await svc.from("qr").delete().eq("by_name", t.name);
    const { error } = await svc.auth.admin.deleteUser(t.id); // kaskádou smaže profil, žádosti, oznámení, push odběry
    return error;
  }

  if (action === "delete") {
    const { data: t } = await svc.from("profiles").select("*").eq("username", String(b.username ?? "")).maybeSingle();
    if (!t || t.id === me.id) return json({ error: "Nelze smazat" }, 400);
    const ok = me.role === "admin" || (me.role === "leader" && t.role === "emp" && t.team === me.team);
    if (!ok) return json({ error: "Nemáte oprávnění" }, 403);
    if (t.role === "admin") return json({ error: "Nelze smazat" }, 400);
    const err = await removeUser(t);
    return err ? json({ error: "Smazání se nepodařilo" }, 500) : json({ ok: true });
  }

  if (me.role !== "admin") return json({ error: "Nemáte oprávnění" }, 403);

  // ---- nový vedoucí
  if (action === "create_leader") {
    const name = String(b.name ?? "").trim().replace(/\s+/g, " "), pw = String(b.password ?? ""), team = String(b.team ?? "");
    if (!NAMEOK.test(name)) return json({ error: "Jméno: 2–30 znaků, písmena a mezery" }, 400);
    if (pw.length < 8) return json({ error: "Heslo musí mít alespoň 8 znaků" }, 400);
    if (!TEAMS.includes(team)) return json({ error: "Neplatný tým" }, 400);
    const username = norm(name);
    const { data: ex } = await svc.from("profiles").select("id").eq("username", username).maybeSingle();
    if (ex) return json({ error: "Toto jméno už existuje" }, 409);
    const { data: cu, error: ce } = await svc.auth.admin.createUser({ email: emailOf(username), password: pw, email_confirm: true });
    if (ce || !cu.user) return json({ error: "Účet se nepodařilo vytvořit" }, 400);
    const { error: pe } = await svc.from("profiles").insert({ id: cu.user.id, username, name, role: "leader", team });
    if (pe) { await svc.auth.admin.deleteUser(cu.user.id); return json({ error: "Profil se nepodařilo vytvořit" }, 400); }
    return json({ ok: true });
  }

  // ---- úprava vedoucího nebo zaměstnance (jméno, heslo, tým, pozice)
  if (action === "update") {
    const { data: t } = await svc.from("profiles").select("*").eq("username", String(b.username ?? "")).maybeSingle();
    if (!t || t.role === "admin") return json({ error: "Nelze upravit" }, 400);
    const name = String(b.name ?? t.name).trim().replace(/\s+/g, " ");
    const team = String(b.team ?? t.team);
    const pos = t.role === "emp" ? String(b.pos ?? t.pos ?? "Operátor") : null;
    const pw = b.password ? String(b.password) : "";
    if (!NAMEOK.test(name)) return json({ error: "Jméno: 2–30 znaků, písmena a mezery" }, 400);
    if (!TEAMS.includes(team)) return json({ error: "Neplatný tým" }, 400);
    if (pos && !POS.includes(pos)) return json({ error: "Neplatná pozice" }, 400);
    if (pw && pw.length < 8) return json({ error: "Heslo musí mít alespoň 8 znaků" }, 400);
    const nk = norm(name);
    if (nk !== t.username) {
      const { data: ex } = await svc.from("profiles").select("id").eq("username", nk).maybeSingle();
      if (ex) return json({ error: "Toto jméno už existuje" }, 409);
    }
    const upd: Record<string, string> = {};
    if (nk !== t.username) upd.email = emailOf(nk);
    if (pw) upd.password = pw;
    if (Object.keys(upd).length) {
      const { error } = await svc.auth.admin.updateUserById(t.id, { ...upd, email_confirm: true });
      if (error) return json({ error: "Změna účtu se nepodařila" }, 400);
    }
    await svc.from("profiles").update({ username: nk, name, team, pos }).eq("id", t.id);
    // propsat změny do žádostí a přihlášek na přesčas
    const { data: mine } = await svc.from("docs").select("id,data").eq("kind", "req").eq("owner", t.id);
    for (const r of mine ?? []) {
      await svc.from("docs").update({ ukey: nk, team, data: { ...r.data, name, team, user: nk } }).eq("kind", "req").eq("id", r.id);
    }
    if (nk !== t.username) {
      const { data: offers } = await svc.from("docs").select("id,data").eq("kind", "offer");
      for (const o of offers ?? []) {
        if (o.data?.apps && t.username in o.data.apps) {
          o.data.apps[nk] = o.data.apps[t.username];
          delete o.data.apps[t.username];
          await svc.from("docs").update({ data: o.data }).eq("kind", "offer").eq("id", o.id);
        }
      }
    }
    await svc.from("notif").insert({ user_id: t.id, title: "Údaje upraveny", msg: "Správce upravil váš profil" });
    return json({ ok: true });
  }

  return json({ error: "Neznámá akce" }, 400);
});
