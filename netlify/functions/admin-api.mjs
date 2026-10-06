/**
 * Easy Gas back office API (Netlify Function, single endpoint: POST /admin-api).
 *
 * Owner-only. Data lives in a private Netlify Blobs store ("easygas-admin"):
 *   auth                password hash, session secret
 *   ledger              settings + restocks + sales + expenses (one JSON document, versioned)
 *   backup/YYYY-MM-DD   first copy of the ledger written each day (safety net)
 *   ratelimit/<hash>    failed-login counters
 *
 * The calculations live in admin/calc.js and are shared with the owner page, so the totals the
 * page shows instantly are the same totals the server works out.
 */
import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import {
  buildExpense,
  buildRestock,
  buildSale,
  DEFAULT_SETTINGS,
  EntryError,
  EXPENSE_CATEGORIES,
  PAYMENT_METHODS,
  snapshotPrices,
  summarise,
  validateSettings,
  withDefaults,
} from "../../admin/calc.js";

export { summarise } from "../../admin/calc.js";

const scrypt = promisify(scryptCb);
const KINDS = { sale: "sales", restock: "restocks", expense: "expenses" };
const BUILDERS = { sale: buildSale, restock: buildRestock, expense: buildExpense };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class UserError extends Error {}

// ---------------------------------------------------------------- auth helpers

async function hashPassword(pw) {
  const salt = randomBytes(16);
  const key = await scrypt(pw.normalize("NFKC"), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
}
async function verifyPassword(pw, stored) {
  const [alg, saltB64, keyB64] = String(stored).split("$");
  if (alg !== "scrypt") return false;
  const expected = Buffer.from(keyB64, "base64url");
  const key = await scrypt(String(pw).normalize("NFKC"), Buffer.from(saltB64, "base64url"), expected.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(key, expected);
}
function sign(secret, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}
function unsign(secret, token) {
  const [body, sig] = String(token ?? "").split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString());
  } catch {
    return null;
  }
}
const COOKIE = "eg_admin";
const SESSION_DAYS = 30;
function readCookie(req, name) {
  const m = (req.headers.get("cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(name + "="));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
function cookieHeader(value, maxAge) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}
function sessionCookie(auth) {
  return cookieHeader(sign(auth.sessionSecret, { exp: Date.now() + SESSION_DAYS * 86400_000, v: auth.version }), SESSION_DAYS * 86400);
}

// ---------------------------------------------------------------- helpers

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", "x-robots-tag": "noindex", ...extraHeaders } });
}
function emptyLedger() {
  return { rev: 0, settings: { ...DEFAULT_SETTINGS }, settingsHistory: [], restocks: [], sales: [], expenses: [] };
}
function kindOf(k) {
  const list = KINDS[k];
  if (!list) throw new UserError("Unknown entry type.");
  return list;
}
function publicLedger(l) {
  return {
    rev: l.rev ?? 0,
    settings: withDefaults(l.settings),
    settingsHistory: (l.settingsHistory ?? []).slice(-20),
    restocks: l.restocks,
    sales: l.sales,
    expenses: l.expenses,
    categories: EXPENSE_CATEGORIES,
    methods: PAYMENT_METHODS,
  };
}

/**
 * Factory so tests can pass an in-memory store. `store` needs get(key,{type:'json'}),
 * getWithMetadata(key,{type:'json'}), setJSON(key,data,opts) and delete(key).
 */
export function createHandler(getStoreFn, env = process.env) {
  return async function handler(req) {
    if (req.method !== "POST") return json(405, { error: "Method not allowed" });
    // Same-origin JSON only (blocks cross-site form posts).
    if (!(req.headers.get("content-type") ?? "").includes("application/json") || req.headers.get("x-easygas") !== "1") return json(400, { error: "Bad request" });

    let body;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "Bad request" });
    }
    const store = getStoreFn();
    const action = String(body.action ?? "");

    try {
      let auth = await store.get("auth", { type: "json" });
      const session = auth ? unsign(auth.sessionSecret, readCookie(req, COOKIE)) : null;
      const signedIn = !!(session && session.exp > Date.now() && session.v === auth.version);

      // ---------- sign-in actions
      if (action === "status") return json(200, { setUp: !!auth, signedIn, setupAvailable: !auth && !!env.EASYGAS_SETUP_CODE });
      if (action === "setup") {
        if (auth) return json(409, { error: "Already set up. Log in instead." });
        const code = env.EASYGAS_SETUP_CODE;
        if (!code || code.length < 8) return json(403, { error: "Setup is not enabled. Add EASYGAS_SETUP_CODE in Netlify first." });
        const a = Buffer.from(String(body.setupCode ?? "")), b = Buffer.from(code);
        if (a.length !== b.length || !timingSafeEqual(a, b)) return json(403, { error: "The setup code is not correct." });
        const pw = String(body.password ?? "");
        if (pw.length < 10) return json(400, { error: "Choose a password of at least 10 characters." });
        auth = { passwordHash: await hashPassword(pw), sessionSecret: randomBytes(32).toString("base64url"), version: 1, createdAt: new Date().toISOString() };
        const created = await store.setJSON("auth", auth, { onlyIfNew: true });
        if (created && created.modified === false) return json(409, { error: "Already set up. Log in instead." });
        return json(200, { ok: true }, { "set-cookie": sessionCookie(auth) });
      }
      if (action === "login") {
        if (!auth) return json(409, { error: "Not set up yet." });
        const ip = req.headers.get("x-nf-client-connection-ip") ?? req.headers.get("x-forwarded-for") ?? "unknown";
        const rlKey = "ratelimit/" + createHash("sha256").update(ip).digest("hex").slice(0, 24);
        const rl = (await store.get(rlKey, { type: "json" })) ?? { n: 0, since: Date.now() };
        if (Date.now() - rl.since > 15 * 60_000) Object.assign(rl, { n: 0, since: Date.now() });
        if (rl.n >= 8) return json(429, { error: "Too many attempts. Wait 15 minutes and try again." });
        if (!(await verifyPassword(body.password ?? "", auth.passwordHash))) {
          rl.n++;
          await store.setJSON(rlKey, rl);
          return json(401, { error: "That password is not correct." });
        }
        await store.delete(rlKey);
        return json(200, { ok: true }, { "set-cookie": sessionCookie(auth) });
      }
      if (action === "logout") return json(200, { ok: true }, { "set-cookie": cookieHeader("", 0) });

      // ---------- everything below needs a valid session
      if (!signedIn) return json(401, { error: "Please log in again.", signedOut: true });

      const read = async () => {
        const loaded = await store.getWithMetadata("ledger", { type: "json" });
        return { ledger: loaded?.data ?? emptyLedger(), etag: loaded?.etag, original: loaded?.data ?? null };
      };

      /**
       * Apply a change and save it. If another phone saved in between, re-read and apply again
       * (every change here is safe to re-apply), so the owner never sees a "try again" error.
       */
      const NO_CHANGE = Symbol("no change");
      const mutate = async (fn) => {
        for (let attempt = 0; attempt < 4; attempt++) {
          const { ledger, etag, original } = await read();
          const result = fn(ledger, NO_CHANGE);
          if (Array.isArray(result) && result[0] === NO_CHANGE) return { result: result[1], rev: ledger.rev ?? 0 };
          ledger.rev = (ledger.rev ?? 0) + 1;
          const today = new Date().toISOString().slice(0, 10);
          if (original && !(await store.get(`backup/${today}`, { type: "json" }))) await store.setJSON(`backup/${today}`, original);
          const res = await store.setJSON("ledger", ledger, etag ? { onlyIfMatch: etag } : { onlyIfNew: true });
          if (!res || res.modified !== false) return { result, rev: ledger.rev };
        }
        throw new UserError("Couldn't save because the data kept changing. Please try again.");
      };

      switch (action) {
        case "load": {
          const { ledger } = await read();
          return json(200, publicLedger(ledger));
        }
        case "rev": {
          // Cheap check used by other devices to see if anything changed.
          const { ledger } = await read();
          return json(200, { rev: ledger.rev ?? 0 });
        }
        case "summary": {
          const { ledger } = await read();
          return json(200, { summary: summarise(ledger, body.from || null, body.to || null) });
        }
        case "add": {
          const list = kindOf(body.kind);
          const id = UUID.test(String(body.id)) ? String(body.id) : crypto.randomUUID();
          const { result, rev } = await mutate((ledger, NO) => {
            const existing = ledger[list].find((e) => e.id === id);
            if (existing) return [NO, existing]; // same entry sent twice (double tap / retry): keep one
            const entry = { id, ...BUILDERS[body.kind](body.entry ?? {}, withDefaults(ledger.settings)), createdAt: new Date().toISOString() };
            ledger[list].push(entry);
            return entry;
          });
          return json(200, { ok: true, entry: result, rev });
        }
        case "update": {
          const list = kindOf(body.kind);
          const { result, rev } = await mutate((ledger) => {
            const i = ledger[list].findIndex((e) => e.id === body.id);
            if (i < 0) throw new UserError("That entry no longer exists. It may have been deleted on another device.");
            const old = ledger[list][i];
            const rebuilt = BUILDERS[body.kind](body.entry ?? {}, snapshotPrices(body.kind, old, ledger.settings));
            ledger[list][i] = { ...rebuilt, id: old.id, createdAt: old.createdAt, updatedAt: new Date().toISOString() };
            return ledger[list][i];
          });
          return json(200, { ok: true, entry: result, rev });
        }
        case "delete": {
          const list = kindOf(body.kind);
          const { result, rev } = await mutate((ledger, NO) => {
            const entry = ledger[list].find((e) => e.id === body.id);
            if (!entry) return [NO, null]; // already gone
            ledger[list] = ledger[list].filter((e) => e.id !== body.id);
            return entry;
          });
          return json(200, { ok: true, deleted: result, rev });
        }
        case "restore": {
          // Undo a delete: put the exact entry back (validated, prices as originally stored).
          const list = kindOf(body.kind);
          const e = body.entry ?? {};
          if (!UUID.test(String(e.id))) throw new UserError("Can't restore that entry.");
          const { rev } = await mutate((ledger, NO) => {
            if (ledger[list].some((x) => x.id === e.id)) return [NO, null];
            const prices = snapshotPrices(body.kind, e, ledger.settings);
            const input =
              body.kind === "sale"
                ? { ...e, kg: e.ckg / 100, received: e.receivedCents / 100 }
                : body.kind === "restock"
                  ? { ...e, kg: e.ckg / 100, paid: e.paidCents / 100 }
                  : { ...e, amount: e.amountCents / 100 };
            ledger[list].push({ ...BUILDERS[body.kind](input, prices), id: e.id, createdAt: e.createdAt ?? new Date().toISOString() });
          });
          return json(200, { ok: true, rev });
        }
        case "updateSettings": {
          // Locked: needs the password again, plus an explicit confirmation from the page.
          if (body.confirm !== "CHANGE") throw new UserError("Type CHANGE to confirm.");
          if (!(await verifyPassword(body.password ?? "", auth.passwordHash))) return json(401, { error: "That password is not correct. Settings were not changed." });
          const next = validateSettings(body.settings ?? {});
          const { rev } = await mutate((ledger) => {
            ledger.settingsHistory = ledger.settingsHistory ?? [];
            ledger.settingsHistory.push({ at: new Date().toISOString(), before: withDefaults(ledger.settings), after: next });
            ledger.settings = next;
          });
          return json(200, { ok: true, settings: next, rev });
        }
        case "changePassword": {
          if (!(await verifyPassword(body.current ?? "", auth.passwordHash))) return json(401, { error: "Current password is not correct." });
          const pw = String(body.next ?? "");
          if (pw.length < 10) throw new UserError("Choose a new password of at least 10 characters.");
          auth = { ...auth, passwordHash: await hashPassword(pw), version: auth.version + 1 };
          await store.setJSON("auth", auth);
          return json(200, { ok: true }, { "set-cookie": sessionCookie(auth) });
        }
        default:
          return json(400, { error: "Unknown action." });
      }
    } catch (e) {
      if (e instanceof UserError || e instanceof EntryError) return json(400, { error: e.message });
      console.error("admin-api error", e instanceof Error ? e.message : e);
      return json(500, { error: "Something went wrong. Please try again." });
    }
  };
}

// ---------------------------------------------------------------- Netlify entry point

export default async (req, context) => {
  const { getStore } = await import("@netlify/blobs");
  return createHandler(() => getStore({ name: "easygas-admin", consistency: "strong" }))(req, context);
};

export const config = { path: "/admin-api" };
