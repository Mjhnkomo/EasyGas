/**
 * Easy Gas back office API (Netlify Function, single endpoint: POST /admin-api).
 *
 * Owner-only. Data lives in a private Netlify Blobs store ("easygas-admin"):
 *   auth                  password hash, session secret
 *   ledger                settings + restocks + daily sales + expenses (one JSON document)
 *   backup/YYYY-MM-DD     first copy of the ledger written each day (safety net)
 *   ratelimit/<hash>      failed-login counters
 *
 * Money is integer cents, weights are integer hundredths of a kg ("ckg"), so 2.5 kg = 250.
 * Every entry stores the prices that applied when it was made; changing settings never
 * rewrites history.
 */
import { createHash, createHmac, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);

// ------------------------- Defaults (owner can change these in Settings) -------------------------

export const DEFAULT_SETTINGS = {
  sellCents: 190, // selling price per kg
  baseBuyCents: 150, // buying price per kg (normal)
  bulkBuyCents: 130, // buying price per kg (bulk)
  bulkMinCkg: 25000, // bulk price applies to restocks of 250 kg or more
  tankCkg: 5000, // one storage tank = 50 kg
  openingStockCkg: 0, // gas already in stock before the first restock was recorded
  openingStockCostCents: 150, // what that opening stock cost per kg
};

export const EXPENSE_CATEGORIES = ["Transport / fuel", "Delivery", "Wages", "Rent", "Equipment / repairs", "Airtime / data", "Other"];

// ------------------------- Pure calculations (unit tested) -------------------------

/** price (cents per kg) x weight (hundredths of kg) -> cents, rounded half-up */
export function costFor(rateCents, ckg) {
  return Math.floor((rateCents * ckg + 50) / 100);
}

export function parseKg(v) {
  const s = String(v ?? "").trim().replace(",", ".");
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(s)) return null;
  const [w, f = ""] = s.split(".");
  const c = Number(w) * 100 + Number((f + "00").slice(0, 2));
  return c > 0 ? c : null;
}

export function parseMoney(v) {
  const s = String(v ?? "").trim().replace(",", ".").replace(/^\$/, "");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return null;
  const [w, f = ""] = s.split(".");
  return Number(w) * 100 + Number((f + "00").slice(0, 2));
}

/** Which buying price applies to a restock of this size. */
export function restockRate(ckg, settings) {
  const bulk = ckg >= settings.bulkMinCkg;
  return { bulk, rateCents: bulk ? settings.bulkBuyCents : settings.baseBuyCents };
}

const inRange = (d, from, to) => (!from || d >= from) && (!to || d <= to);

/**
 * Summary for a period. Stock is valued at moving average cost, so "profit on gas sold" uses what
 * the gas that was actually sold cost, not whatever happened to be bought that week.
 */
export function summarise(ledger, from, to) {
  const s = ledger.settings;
  // Chronological: restocks before sales on the same day, so a morning restock is available to sell.
  const events = [
    ...ledger.restocks.map((r) => ({ t: "r", date: r.date, order: 0, r })),
    ...ledger.sales.map((x) => ({ t: "s", date: x.date, order: 1, x })),
  ].sort((a, b) => (a.date === b.date ? a.order - b.order : a.date < b.date ? -1 : 1));

  let stockCkg = s.openingStockCkg;
  let stockValue = (s.openingStockCostCents * s.openingStockCkg) / 100; // cents, kept unrounded
  let shortfallCkg = 0;

  const p = { boughtCkg: 0, boughtPaidCents: 0, bulkSavingsCents: 0, restocks: 0, bulkRestocks: 0, soldCkg: 0, expectedCents: 0, receivedCents: 0, cogs: 0, salesDays: 0 };

  for (const e of events) {
    if (e.t === "r") {
      stockCkg += e.r.ckg;
      stockValue += e.r.paidCents;
      if (inRange(e.date, from, to)) {
        p.restocks++;
        if (e.r.bulk) p.bulkRestocks++;
        p.boughtCkg += e.r.ckg;
        p.boughtPaidCents += e.r.paidCents;
        p.bulkSavingsCents += Math.max(0, costFor(e.r.baseBuyCents, e.r.ckg) - costFor(e.r.rateCents, e.r.ckg));
      }
    } else {
      const avg = stockCkg > 0 ? stockValue / stockCkg : 0; // cents per ckg
      const fromStock = Math.min(e.x.ckg, Math.max(0, stockCkg));
      const missing = e.x.ckg - fromStock;
      // If more is sold than was recorded in stock, cost the gap at the normal buying price and warn.
      const cogs = fromStock * avg + (missing * s.baseBuyCents) / 100;
      stockValue -= fromStock * avg;
      stockCkg -= fromStock;
      if (missing > 0) shortfallCkg += missing;
      if (inRange(e.date, from, to)) {
        p.salesDays++;
        p.soldCkg += e.x.ckg;
        p.expectedCents += e.x.expectedCents;
        p.receivedCents += e.x.receivedCents;
        p.cogs += cogs;
      }
    }
  }

  const expenses = ledger.expenses.filter((x) => inRange(x.date, from, to));
  const expensesCents = expenses.reduce((a, x) => a + x.amountCents, 0);
  const byCategory = {};
  for (const x of expenses) byCategory[x.category] = (byCategory[x.category] ?? 0) + x.amountCents;

  const cogsCents = Math.round(p.cogs);
  const grossProfitCents = p.receivedCents - cogsCents;
  return {
    from: from ?? null,
    to: to ?? null,
    gasBought: { kgCkg: p.boughtCkg, paidCents: p.boughtPaidCents, restocks: p.restocks, bulkRestocks: p.bulkRestocks, bulkSavingsCents: p.bulkSavingsCents },
    sales: { kgCkg: p.soldCkg, expectedCents: p.expectedCents, receivedCents: p.receivedCents, differenceCents: p.receivedCents - p.expectedCents, days: p.salesDays },
    expenses: { totalCents: expensesCents, byCategory },
    profitOnGasSold: {
      costOfGasSoldCents: cogsCents,
      grossProfitCents,
      netProfitCents: grossProfitCents - expensesCents,
      profitPerKgCents: p.soldCkg > 0 ? Math.round(((grossProfitCents - expensesCents) * 100) / p.soldCkg) : null,
    },
    cash: { inCents: p.receivedCents, outGasCents: p.boughtPaidCents, outExpensesCents: expensesCents, netCents: p.receivedCents - p.boughtPaidCents - expensesCents },
    stockNow: {
      kgCkg: Math.max(0, stockCkg),
      valueCents: Math.round(Math.max(0, stockValue)),
      avgCostCents: stockCkg > 0 ? Math.round((stockValue / stockCkg) * 100) : null,
      tanks: s.tankCkg > 0 ? Math.round((Math.max(0, stockCkg) / s.tankCkg) * 10) / 10 : null,
      shortfallCkg,
    },
  };
}

// ------------------------- Validation -------------------------

class UserError extends Error {}
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function vDate(v) {
  if (!DATE.test(String(v)) || Number.isNaN(Date.parse(v))) throw new UserError("Choose a valid date.");
  return String(v);
}
function vNote(v) {
  return String(v ?? "").trim().slice(0, 300);
}

export function buildRestock(input, settings) {
  const date = vDate(input.date);
  let ckg = parseKg(input.kg);
  if (!ckg && input.tanks) {
    const tanks = Number(input.tanks);
    if (!Number.isInteger(tanks) || tanks < 1 || tanks > 100) throw new UserError("Enter the number of tanks filled (1 to 100).");
    ckg = tanks * settings.tankCkg;
  }
  if (!ckg || ckg > 10_000_000) throw new UserError("Enter how many kg were bought.");
  const { bulk, rateCents } = restockRate(ckg, settings);
  const calcCents = costFor(rateCents, ckg);
  let paidCents = calcCents;
  if (input.paid !== undefined && String(input.paid).trim() !== "") {
    const pc = parseMoney(input.paid);
    if (pc === null) throw new UserError("Enter the amount paid, e.g. 325.00, or leave it blank.");
    paidCents = pc;
  }
  return { id: randomUUID(), date, ckg, bulk, rateCents, baseBuyCents: settings.baseBuyCents, calcCents, paidCents, note: vNote(input.note), createdAt: new Date().toISOString() };
}

export function buildSale(input, settings) {
  const date = vDate(input.date);
  const ckg = parseKg(input.kg);
  if (!ckg) throw new UserError("Enter how many kg were sold.");
  const receivedCents = parseMoney(input.received);
  if (receivedCents === null) throw new UserError("Enter the money actually received, e.g. 171.00.");
  return { id: randomUUID(), date, ckg, sellCents: settings.sellCents, expectedCents: costFor(settings.sellCents, ckg), receivedCents, note: vNote(input.note), createdAt: new Date().toISOString() };
}

export function buildExpense(input) {
  const date = vDate(input.date);
  const category = EXPENSE_CATEGORIES.includes(input.category) ? input.category : null;
  if (!category) throw new UserError("Choose an expense category.");
  const amountCents = parseMoney(input.amount);
  if (!amountCents) throw new UserError("Enter the expense amount.");
  return { id: randomUUID(), date, category, amountCents, note: vNote(input.note), createdAt: new Date().toISOString() };
}

export function validateSettings(input) {
  const money = (k, label) => {
    const v = parseMoney(input[k]);
    if (v === null || v <= 0 || v > 100000) throw new UserError(`Enter a valid ${label}.`);
    return v;
  };
  const kg = (k, label, allowZero = false) => {
    const s = String(input[k] ?? "").trim();
    if (allowZero && (s === "" || s === "0")) return 0;
    const v = parseKg(s);
    if (!v) throw new UserError(`Enter a valid ${label} in kg.`);
    return v;
  };
  const out = {
    sellCents: money("sell", "selling price"),
    baseBuyCents: money("baseBuy", "normal buying price"),
    bulkBuyCents: money("bulkBuy", "bulk buying price"),
    bulkMinCkg: kg("bulkMinKg", "bulk threshold"),
    tankCkg: kg("tankKg", "tank size"),
    openingStockCkg: kg("openingStockKg", "opening stock", true),
    openingStockCostCents: money("openingStockCost", "opening stock cost"),
  };
  if (out.bulkBuyCents > out.baseBuyCents) throw new UserError("The bulk price should not be higher than the normal buying price.");
  return out;
}

// ------------------------- Auth helpers -------------------------

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

// ------------------------- Handler -------------------------

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", "x-robots-tag": "noindex", ...extraHeaders } });
}

function emptyLedger() {
  return { settings: { ...DEFAULT_SETTINGS }, settingsHistory: [], restocks: [], sales: [], expenses: [] };
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

      // -- First-time setup: requires the setup code the owner put in Netlify's environment variables.
      if (action === "status") {
        const session = auth ? unsign(auth.sessionSecret, readCookie(req, COOKIE)) : null;
        const ok = !!(session && session.exp > Date.now() && session.v === auth.version);
        return json(200, { setUp: !!auth, signedIn: ok, setupAvailable: !auth && !!env.EASYGAS_SETUP_CODE });
      }
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
        const token = sign(auth.sessionSecret, { exp: Date.now() + SESSION_DAYS * 86400_000, v: auth.version });
        return json(200, { ok: true }, { "set-cookie": cookieHeader(token, SESSION_DAYS * 86400) });
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
        const token = sign(auth.sessionSecret, { exp: Date.now() + SESSION_DAYS * 86400_000, v: auth.version });
        return json(200, { ok: true }, { "set-cookie": cookieHeader(token, SESSION_DAYS * 86400) });
      }
      if (action === "logout") return json(200, { ok: true }, { "set-cookie": cookieHeader("", 0) });

      // -- Everything below needs a valid session.
      const session = auth ? unsign(auth.sessionSecret, readCookie(req, COOKIE)) : null;
      if (!session || session.exp < Date.now() || session.v !== auth.version) return json(401, { error: "Please log in again.", signedOut: true });

      // Load the ledger with its version tag so two saves can't overwrite each other.
      const loaded = await store.getWithMetadata("ledger", { type: "json" });
      const ledger = loaded?.data ?? emptyLedger();
      const etag = loaded?.etag;

      const save = async () => {
        const today = new Date().toISOString().slice(0, 10);
        if (loaded && !(await store.get(`backup/${today}`, { type: "json" }))) await store.setJSON(`backup/${today}`, loaded.data);
        const res = await store.setJSON("ledger", ledger, etag ? { onlyIfMatch: etag } : { onlyIfNew: true });
        if (res && res.modified === false) throw new UserError("Someone else saved at the same moment. Please try again.");
      };

      switch (action) {
        case "load": {
          const { from, to } = body;
          return json(200, { settings: ledger.settings, settingsHistory: ledger.settingsHistory.slice(-20), restocks: ledger.restocks, sales: ledger.sales, expenses: ledger.expenses, categories: EXPENSE_CATEGORIES, summary: summarise(ledger, from || null, to || null) });
        }
        case "summary":
          return json(200, { summary: summarise(ledger, body.from || null, body.to || null) });
        case "addRestock": {
          const r = buildRestock(body, ledger.settings);
          ledger.restocks.push(r);
          await save();
          return json(200, { ok: true, entry: r });
        }
        case "addSale": {
          const x = buildSale(body, ledger.settings);
          if (ledger.sales.some((s) => s.date === x.date) && !body.allowSecond) return json(409, { error: "Sales for this date are already recorded. Delete that entry first, or confirm to add a second one.", duplicateDate: true });
          ledger.sales.push(x);
          await save();
          return json(200, { ok: true, entry: x });
        }
        case "addExpense": {
          const x = buildExpense(body);
          ledger.expenses.push(x);
          await save();
          return json(200, { ok: true, entry: x });
        }
        case "delete": {
          const kind = { restock: "restocks", sale: "sales", expense: "expenses" }[body.kind];
          if (!kind) throw new UserError("Unknown entry type.");
          const before = ledger[kind].length;
          ledger[kind] = ledger[kind].filter((e) => e.id !== body.id);
          if (ledger[kind].length === before) throw new UserError("That entry no longer exists.");
          await save();
          return json(200, { ok: true });
        }
        case "updateSettings": {
          // Locked: needs the password again, plus an explicit confirmation from the page.
          if (body.confirm !== "CHANGE") throw new UserError("Type CHANGE to confirm.");
          if (!(await verifyPassword(body.password ?? "", auth.passwordHash))) return json(401, { error: "That password is not correct. Settings were not changed." });
          const next = validateSettings(body.settings ?? {});
          ledger.settingsHistory.push({ at: new Date().toISOString(), before: ledger.settings, after: next });
          ledger.settings = next;
          await save();
          return json(200, { ok: true, settings: next });
        }
        case "changePassword": {
          if (!(await verifyPassword(body.current ?? "", auth.passwordHash))) return json(401, { error: "Current password is not correct." });
          const pw = String(body.next ?? "");
          if (pw.length < 10) throw new UserError("Choose a new password of at least 10 characters.");
          // New version signs every other device out.
          auth = { ...auth, passwordHash: await hashPassword(pw), version: auth.version + 1 };
          await store.setJSON("auth", auth);
          const token = sign(auth.sessionSecret, { exp: Date.now() + SESSION_DAYS * 86400_000, v: auth.version });
          return json(200, { ok: true }, { "set-cookie": cookieHeader(token, SESSION_DAYS * 86400) });
        }
        default:
          return json(400, { error: "Unknown action." });
      }
    } catch (e) {
      if (e instanceof UserError) return json(400, { error: e.message });
      console.error("admin-api error", e instanceof Error ? e.message : e);
      return json(500, { error: "Something went wrong. Please try again." });
    }
  };
}

// ------------------------- Netlify entry point -------------------------

export default async (req, context) => {
  const { getStore } = await import("@netlify/blobs");
  return createHandler(() => getStore({ name: "easygas-admin", consistency: "strong" }))(req, context);
};

export const config = { path: "/admin-api" };
