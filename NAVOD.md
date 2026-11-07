# RB SHIFT – nasazení krok za krokem (Supabase + PWA + push)

Výsledek: aplikace běží na internetu, instaluje se na plochu telefonu a když vedoucí zadá přesčas, všem vybraným zaměstnancům hned přijde upozornění.

## Co je v balíčku

| Soubor | K čemu je |
|---|---|
| `index.html` | samotná aplikace (sem vložíš 3 hodnoty v kroku 4) |
| `manifest.webmanifest`, `sw.js`, `icon*.png/svg` | instalace na plochu a příjem upozornění |
| `schema.sql` | databáze, pravidla kdo co vidí a smí |
| `supabase/functions/register` | registrace zaměstnance přes QR |
| `supabase/functions/manage-user` | správa účtů (admin, vedoucí) |
| `supabase/functions/push` | rozesílání upozornění do telefonů |
| `generate-vapid.js` | vygeneruje klíče pro upozornění |

## Jak to funguje (a proč je to bezpečné)

- Aplikace je jen statický web, který může být veřejný. Žádná data v něm nejsou.
- Data jsou v Supabase a každý uživatel se k nim dostane jen po přihlášení. O tom, co kdo vidí, rozhoduje databáze (RLS), ne aplikace. Zaměstnanec vidí jen své žádosti, vedoucí svůj tým.
- Účty zakládá jen server: zaměstnanec přes jednorázový QR kód, vedoucí přes admina. Veřejná registrace je vypnutá.
- Hesla ukládá Supabase zahashovaná. V aplikaci žádná hesla nejsou.
- Tajné klíče (`service_role`, VAPID soukromý) jsou jen v Supabase Secrets. Do `index.html` ani na GitHub nepatří.

---

## Krok 1: Supabase – databáze

1. Otevři projekt v Supabase → **SQL Editor** → **New query**.
2. Vlož celý obsah `schema.sql` a klikni **Run**. Mělo by to skončit bez chyby ("Success").
3. **Table Editor**: ověř, že existují tabulky `profiles`, `docs`, `qr`, `notif`, `push_subs` a u každé je štítek **RLS enabled**. Pokud někde chybí, nepokračuj.

## Krok 2: Supabase – nastavení přihlášení

V **Authentication**:

1. **Sign In / Providers** → **Email**: vypni **Allow new users to sign up** (zapnuté = kdokoli by si mohl vytvořit účet). Potvrzování e-mailem nepotřebuješ, účty zakládá server.
2. Nastav **Minimum password length** na 8 nebo víc (aplikace už 8 vyžaduje).
3. **Rate Limits**: nech výchozí hodnoty (chrání proti hádání hesel).

## Krok 3: První správce (superadmin)

1. **Authentication → Users → Add user → Create new user**.
2. E-mail: `u61646d696e@rbshift.example.com` (je to slovo "admin" zakódované, aplikace si e-mail skládá z přihlašovacího jména sama). Heslo: silné, vlastní, aspoň 10 znaků. Zaškrtni **Auto Confirm User**.
3. V **SQL Editoru** spusť:

```sql
insert into public.profiles (id, username, name, role)
select id, 'admin', 'admin', 'admin' from auth.users where email = 'u61646d696e@rbshift.example.com'
on conflict (id) do nothing;
```

Přihlašovací jméno v aplikaci bude `admin` a heslo to, které jsi zadal.

## Krok 4: Klíče a úprava `index.html`

1. V Supabase **Project Settings → API** (nebo **API Keys**) zkopíruj:
   - **Project URL** (`https://xxxx.supabase.co`)
   - **publishable / anon public** klíč.
   - **Nikdy** nepoužívej klíč `service_role` ani `secret`.
2. Na svém počítači spusť `node generate-vapid.js`. Dostaneš `VAPID_PUBLIC` a `VAPID_PRIVATE`. Obojí si zatím někam bezpečně ulož (správce hesel).
3. V `index.html` najdi řádek začínající `const CFG=` a nahraď tři hodnoty:

```js
const CFG={url:'https://xxxx.supabase.co',key:'tvůj-publishable-klíč',vapid:'tvůj-VAPID_PUBLIC'};
```

## Krok 5: Supabase – Edge Functions (serverový kód)

V **Edge Functions → Deploy a new function** (přes editor v prohlížeči) vytvoř tři funkce. Název musí být přesně takto a kód vlož z odpovídajícího souboru:

| Název | Soubor | Verify JWT |
|---|---|---|
| `register` | `supabase/functions/register/index.ts` | **VYPNOUT** (volá ji nepřihlášený nový zaměstnanec, ověřením je QR kód) |
| `manage-user` | `supabase/functions/manage-user/index.ts` | **ZAPNOUT** |
| `push` | `supabase/functions/push/index.ts` | **VYPNOUT** (volá ji databáze, chrání ji tajný klíč v kroku 6) |

Potom **Edge Functions → Secrets** a přidej:

| Secret | Hodnota |
|---|---|
| `VAPID_PUBLIC` | veřejný klíč z kroku 4 |
| `VAPID_PRIVATE` | soukromý klíč z kroku 4 |
| `VAPID_SUBJECT` | `mailto:tvuj@email.cz` |
| `WEBHOOK_SECRET` | dlouhý náhodný řetězec (min. 32 znaků, vymysli si ho) |
| `ALLOWED_ORIGIN` | adresa aplikace bez lomítka na konci, např. `https://tvoje-jmeno.github.io` (doplň po kroku 7) |

`SUPABASE_URL` a `SUPABASE_SERVICE_ROLE_KEY` funkce dostávají automaticky, nepřidávej je.

## Krok 6: Upozornění při každém novém oznámení (Database Webhook)

1. **Database → Webhooks → Create a new hook**.
2. Název `push-on-notif`, tabulka `notif`, událost **Insert**.
3. Typ **Supabase Edge Functions**, funkce `push`, metoda POST.
4. Přidej HTTP hlavičku `x-webhook-secret` s hodnotou stejnou jako `WEBHOOK_SECRET` z kroku 5.
5. Ulož.

Tohle je to, co způsobí, že telefon zavibruje v okamžiku, kdy vedoucí zadá přesčas (aplikace při zadání přesčasu zapíše oznámení každému vybranému zaměstnanci, databáze zavolá funkci `push`, ta pošle upozornění).

## Krok 7: Nahrání aplikace na internet

1. Na GitHubu v repozitáři nahraj do kořene: `index.html`, `manifest.webmanifest`, `sw.js`, všechny `icon*` soubory. Složku `supabase`, `schema.sql`, `generate-vapid.js` a tento návod do repozitáře dát můžeš, ale web je nepotřebuje.
2. **Pozor na GitHub Pages**: na bezplatném účtu běží Pages jen z veřejného repozitáře. V aplikaci nejsou žádné tajné údaje (data jsou chráněna přihlášením), takže veřejný repozitář je přijatelný. Pokud ho chceš soukromý, použij **Cloudflare Pages** nebo **Netlify** (propojí se s GitHubem, privátní repozitář umí; podmínky si ověř u poskytovatele).
3. GitHub Pages: **Settings → Pages → Deploy from a branch → main / (root)**. Za minutu dostaneš adresu `https://tvoje-jmeno.github.io/nazev-repa/`.
4. Vrať se do kroku 5 a nastav `ALLOWED_ORIGIN` na `https://tvoje-jmeno.github.io` (jen původ, bez cesty).
5. Aplikace musí běžet přes **https** (Pages, Cloudflare i Netlify to splňují), jinak nefunguje instalace ani upozornění.

## Krok 8: Vyzkoušej celý řetězec

1. Otevři adresu aplikace, přihlas se jako `admin`.
2. **Uživatelé → Nový vedoucí**: vytvoř vedoucího (jméno, tým, heslo min. 8 znaků). Odhlas se.
3. Přihlas se jako vedoucí, **Profil → Vygenerovat QR pro zaměstnance**, vyber pozici.
4. Na telefonu zaměstnance otevři aplikaci → **Registrace přes QR**, vyplň jméno, heslo (min. 8 znaků) a kód z QR.
5. Na telefonu zaměstnance aplikaci **nainstaluj** a zapni upozornění (viz níže).
6. Aby přesčas viděl zaměstnanec jiného týmu, musí být z jiného týmu než vedoucí, který ho nabízí. Vytvoř druhého vedoucího nebo zaměstnance v jiném týmu.
7. Vedoucí → **Přesčasy → Nová nabídka přesčasu** s pozicí zaměstnance. Telefon zaměstnance musí během pár sekund zavibrovat a ukázat upozornění, i když je aplikace zavřená.

### Instalace a upozornění na telefonu

- **Android (Chrome)**: menu ⋮ → **Instalovat aplikaci**. Po otevření klepni v aplikaci na **Zapnout** u upozornění a povol je.
- **iPhone (Safari, iOS 16.4 a novější)**: **Sdílet → Přidat na plochu**. Otevři aplikaci **z plochy** (ne ze Safari), klepni na **Zapnout** u upozornění a povol je. V režimu Nerušit a při vypnutých oznámeních v Nastavení upozornění nepřijdou. Na iOS mohou upozornění občas přestat chodit, pomůže aplikaci znovu otevřít.

---

## Bezpečnostní kontrola před ostrým provozem

- [ ] Registrace nových uživatelů v Authentication je vypnutá.
- [ ] U všech tabulek je zapnuté RLS.
- [ ] V `index.html` není žádný klíč `service_role`/`secret`.
- [ ] `register` a `push` mají Verify JWT vypnuté, `manage-user` zapnuté.
- [ ] Heslo admina je silné a jedinečné.
- [ ] VAPID soukromý klíč je jen v Supabase Secrets.
- [ ] Zálohy: v Supabase zkontroluj, jak se projekt zálohuje (bezplatný plán nemusí mít automatické zálohy). Občas si exportuj data.
- [ ] Bezplatné projekty Supabase se při nečinnosti pozastavují. Aplikaci pak někdo musí znovu spustit v dashboardu.

## Co aplikace (zatím) nezajišťuje

Je dobré to vědět dřív, než do ní dáš skutečná data:

1. **Pravidla přesčasů** (odpočinek, měsíční limit, 24h maximum) kontroluje aplikace ve vedoucím v telefonu. Server je nevynucuje. Vedoucí s technickými znalostmi by je mohl obejít. Pro běžný provoz stačí, pro přísnou kontrolu by se musela přesunout do databáze.
2. **Přihlášení vyžaduje jméno a heslo**, e-mail ani SMS se nepoužívá. Zapomenuté heslo změní admin v **Uživatelé → Upravit**.
3. **Všichni přihlášení vidí jména, týmy a pozice kolegů** (nutné pro přesčasy mezi týmy). Žádosti o dovolenou a nemoc vidí jen daný zaměstnanec a vedoucí jeho týmu.
4. **Oznámení může vytvořit každý přihlášený uživatel** (aplikace tak upozorňuje ostatní). Zlý úmysl uvnitř firmy by mohl rozesílat falešná upozornění.
5. **Záznamy o nemoci, OČR a lékaři jsou údaje o zdraví**, tedy zvláštní kategorie osobních údajů podle GDPR. Před ostrým provozem to prober s osobou zodpovědnou za ochranu osobních údajů u vás ve firmě a ověř, v jaké oblasti (region) běží tvůj projekt Supabase (vhodná je EU).
6. Skripty aplikace se načítají z CDN (jsDelivr). Pro vyšší bezpečnost je možné je později uložit přímo do repozitáře.

## Úpravy a rozpis směn

- Změnu aplikace nahraješ tak, že přepíšeš `index.html` v repozitáři. Data zůstanou v Supabase. Po změně soubor `sw.js` upravit nemusíš, aplikace si novou verzi stáhne při dalším otevření.
- Rozpis směn na další rok: admin → **Rozpis** → export, úprava v textovém editoru, načtení. Rozpis se uloží do databáze a hned se promítne všem.

## Když něco nejde

| Příznak | Co zkontrolovat |
|---|---|
| "Nepodařilo se načíst data" po přihlášení | špatné `url` nebo `key` v `index.html`; spuštěný `schema.sql` |
| Přihlášení admina říká nesprávné heslo | e-mail uživatele musí být přesně `u61646d696e@rbshift.example.com`; v Users je potvrzený |
| "Účet nemá vytvořený profil" | chybí příkaz `insert into public.profiles` z kroku 3 |
| Registrace přes QR hlásí chybu | funkce `register` nenasazená nebo má zapnuté Verify JWT; kód už použit |
| Správa uživatelů hlásí "Akce se nepodařila" | funkce `manage-user` nenasazená; `ALLOWED_ORIGIN` neodpovídá adrese aplikace |
| Přesčas se vytvoří, ale upozornění nepřijde | chybí webhook (krok 6), špatný `WEBHOOK_SECRET`, chybí VAPID Secrets; zaměstnanec nezapnul upozornění; v Supabase u funkce `push` zkontroluj **Logs** |
| Upozornění nechodí na iPhonu | aplikace není přidaná na plochu nebo není otevřená z plochy |
| Vedoucí nevidí přihlášku zaměstnance | zaměstnanec musí být z jiného týmu a mít pozici, kterou nabídka požaduje |
