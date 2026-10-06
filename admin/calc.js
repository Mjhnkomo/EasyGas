// Easy Gas back office: shared calculations.
// Used by the owner page (admin/index.html) for instant totals AND by the server
// (netlify/functions/admin-api.mjs) when saving, so both always agree.
// Money is integer cents; weights are integer hundredths of a kg ("ckg"): 2.5 kg = 250.

export const DEFAULT_SETTINGS = {
  sellCents: 190, // selling price per kg
  baseBuyCents: 150, // buying price per kg (normal)
  bulkBuyCents: 130, // buying price per kg (bulk)
  bulkMinCkg: 25000, // bulk price applies to a restock of 250 kg or more
  tankCkg: 5000, // one storage tank = 50 kg
  openingStockCkg: 0, // gas already in stock before recording started
  openingStockCostCents: 150, // what that opening stock cost per kg
  lowStockCkg: 5000, // warn when stock falls below this (default 1 tank)
  quickSizesCkg: [300, 500, 900, 1100, 1400, 1900, 4800], // one-tap sizes on the sale screen
};

export const EXPENSE_CATEGORIES = ["Transport / fuel", "Delivery", "Wages", "Rent", "Equipment / repairs", "Airtime / data", "Other"];
export const PAYMENT_METHODS = ["EcoCash", "Cash", "Other"];

export function withDefaults(settings) {
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

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
  const s = withDefaults(settings);
  const bulk = ckg >= s.bulkMinCkg;
  return { bulk, rateCents: bulk ? s.bulkBuyCents : s.baseBuyCents };
}

const inRange = (d, from, to) => (!from || d >= from) && (!to || d <= to);
const sortKey = (e) => `${e.date}T${e.time || "00:00"}`;

/**
 * Totals for a period (dates inclusive, either may be null). Stock is valued at moving average
 * cost, so "profit on gas sold" uses what the sold gas actually cost.
 */
export function summarise(ledger, from, to) {
  const s = withDefaults(ledger.settings);
  // Same moment: restocks first, so gas bought that morning can be sold that day.
  const events = [
    ...ledger.restocks.map((r) => ({ t: "r", k: sortKey(r), o: 0, r })),
    ...ledger.sales.map((x) => ({ t: "s", k: sortKey(x), o: 1, x })),
  ].sort((a, b) => (a.k === b.k ? a.o - b.o : a.k < b.k ? -1 : 1));

  let stockCkg = s.openingStockCkg;
  let stockValue = (s.openingStockCostCents * s.openingStockCkg) / 100;
  let shortfallCkg = 0;
  const p = { boughtCkg: 0, paid: 0, savings: 0, restocks: 0, bulkRestocks: 0, soldCkg: 0, expected: 0, received: 0, cogs: 0, sales: 0 };
  const byMethod = {};
  const byDay = {};
  const day = (d) => (byDay[d] ??= { date: d, receivedCents: 0, cogs: 0, expensesCents: 0, soldCkg: 0 });

  for (const e of events) {
    if (e.t === "r") {
      stockCkg += e.r.ckg;
      stockValue += e.r.paidCents;
      if (inRange(e.r.date, from, to)) {
        p.restocks++;
        if (e.r.bulk) p.bulkRestocks++;
        p.boughtCkg += e.r.ckg;
        p.paid += e.r.paidCents;
        p.savings += Math.max(0, costFor(e.r.baseBuyCents ?? s.baseBuyCents, e.r.ckg) - costFor(e.r.rateCents, e.r.ckg));
      }
    } else {
      const x = e.x;
      const avg = stockCkg > 0 ? stockValue / stockCkg : 0;
      const fromStock = Math.min(x.ckg, Math.max(0, stockCkg));
      const missing = x.ckg - fromStock;
      const cogs = fromStock * avg + (missing * s.baseBuyCents) / 100;
      stockValue -= fromStock * avg;
      stockCkg -= fromStock;
      if (missing > 0) shortfallCkg += missing;
      if (inRange(x.date, from, to)) {
        p.sales++;
        p.soldCkg += x.ckg;
        p.expected += x.expectedCents;
        p.received += x.receivedCents;
        p.cogs += cogs;
        const m = x.method || "Not recorded";
        byMethod[m] = (byMethod[m] ?? 0) + x.receivedCents;
        const d = day(x.date);
        d.receivedCents += x.receivedCents;
        d.cogs += cogs;
        d.soldCkg += x.ckg;
      }
    }
  }

  const expenses = ledger.expenses.filter((x) => inRange(x.date, from, to));
  const expensesCents = expenses.reduce((a, x) => a + x.amountCents, 0);
  const byCategory = {};
  for (const x of expenses) {
    byCategory[x.category] = (byCategory[x.category] ?? 0) + x.amountCents;
    day(x.date).expensesCents += x.amountCents;
  }

  const cogsCents = Math.round(p.cogs);
  const gross = p.received - cogsCents;
  const net = gross - expensesCents;
  const stockKg = Math.max(0, stockCkg);
  return {
    from: from ?? null,
    to: to ?? null,
    gasBought: { kgCkg: p.boughtCkg, paidCents: p.paid, restocks: p.restocks, bulkRestocks: p.bulkRestocks, bulkSavingsCents: p.savings },
    sales: { kgCkg: p.soldCkg, expectedCents: p.expected, receivedCents: p.received, differenceCents: p.received - p.expected, count: p.sales, byMethod },
    expenses: { totalCents: expensesCents, byCategory, count: expenses.length },
    profitOnGasSold: {
      costOfGasSoldCents: cogsCents,
      grossProfitCents: gross,
      netProfitCents: net,
      profitPerKgCents: p.soldCkg > 0 ? Math.round((net * 100) / p.soldCkg) : null,
    },
    cash: { inCents: p.received, outGasCents: p.paid, outExpensesCents: expensesCents, netCents: p.received - p.paid - expensesCents },
    stockNow: {
      kgCkg: stockKg,
      valueCents: Math.round(Math.max(0, stockValue)),
      avgCostCents: stockCkg > 0 ? Math.round((stockValue / stockCkg) * 100) : null,
      tanks: s.tankCkg > 0 ? Math.round((stockKg / s.tankCkg) * 10) / 10 : null,
      low: stockKg < s.lowStockCkg,
      shortfallCkg,
    },
    days: Object.values(byDay)
      .map((d) => ({ date: d.date, receivedCents: d.receivedCents, soldCkg: d.soldCkg, expensesCents: d.expensesCents, profitCents: d.receivedCents - Math.round(d.cogs) - d.expensesCents }))
      .sort((a, b) => (a.date < b.date ? -1 : 1)),
  };
}

// ---------------------------------------------------------------- entry builders
// Each builder validates input and stores the prices that applied at the time.

export class EntryError extends Error {}
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function vDate(v) {
  if (!DATE.test(String(v)) || Number.isNaN(Date.parse(v))) throw new EntryError("Choose a valid date.");
  return String(v);
}
function vTime(v) {
  return TIME.test(String(v ?? "")) ? String(v) : "12:00";
}
function vNote(v) {
  return String(v ?? "").trim().slice(0, 300);
}

/** prices: current settings for new entries, or the entry's own snapshot when editing. */
export function buildSale(input, prices) {
  const s = withDefaults(prices);
  const ckg = parseKg(input.kg);
  if (!ckg) throw new EntryError("Enter how many kg were sold.");
  const expectedCents = costFor(s.sellCents, ckg);
  let receivedCents = expectedCents;
  if (input.received !== undefined && String(input.received).trim() !== "") {
    receivedCents = parseMoney(input.received);
    if (receivedCents === null) throw new EntryError("Enter the money received, e.g. 17.10.");
  }
  const method = PAYMENT_METHODS.includes(input.method) ? input.method : null; // null = not recorded
  return { date: vDate(input.date), time: vTime(input.time), ckg, sellCents: s.sellCents, expectedCents, receivedCents, method, note: vNote(input.note) };
}

export function buildRestock(input, prices) {
  const s = withDefaults(prices);
  let ckg = parseKg(input.kg);
  if (!ckg && input.tanks !== undefined && String(input.tanks).trim() !== "") {
    const tanks = Number(input.tanks);
    if (!Number.isInteger(tanks) || tanks < 1 || tanks > 100) throw new EntryError("Enter the number of tanks filled (1 to 100).");
    ckg = tanks * s.tankCkg;
  }
  if (!ckg || ckg > 10_000_000) throw new EntryError("Enter how many kg were bought, or the number of tanks.");
  const { bulk, rateCents } = restockRate(ckg, s);
  const calcCents = costFor(rateCents, ckg);
  let paidCents = calcCents;
  if (input.paid !== undefined && String(input.paid).trim() !== "") {
    paidCents = parseMoney(input.paid);
    if (paidCents === null) throw new EntryError("Enter the amount paid, e.g. 325.00, or leave it blank.");
  }
  return {
    date: vDate(input.date),
    time: vTime(input.time),
    ckg,
    bulk,
    rateCents,
    calcCents,
    paidCents,
    // price rules in force, so editing later uses the same rules
    baseBuyCents: s.baseBuyCents,
    bulkBuyCents: s.bulkBuyCents,
    bulkMinCkg: s.bulkMinCkg,
    tankCkg: s.tankCkg,
    note: vNote(input.note),
  };
}

export function buildExpense(input) {
  const category = EXPENSE_CATEGORIES.includes(input.category) ? input.category : null;
  if (!category) throw new EntryError("Choose an expense category.");
  const amountCents = parseMoney(input.amount);
  if (!amountCents) throw new EntryError("Enter the expense amount.");
  return { date: vDate(input.date), time: vTime(input.time), category, amountCents, note: vNote(input.note) };
}

/** Prices stored on an existing entry, used when it is edited. */
export function snapshotPrices(kind, entry, current) {
  const s = withDefaults(current);
  if (kind === "sale") return { ...s, sellCents: entry.sellCents ?? s.sellCents };
  if (kind === "restock")
    return { ...s, baseBuyCents: entry.baseBuyCents ?? s.baseBuyCents, bulkBuyCents: entry.bulkBuyCents ?? s.bulkBuyCents, bulkMinCkg: entry.bulkMinCkg ?? s.bulkMinCkg, tankCkg: entry.tankCkg ?? s.tankCkg };
  return s;
}

export function validateSettings(input) {
  const money = (k, label) => {
    const v = parseMoney(input[k]);
    if (v === null || v <= 0 || v > 100000) throw new EntryError(`Enter a valid ${label}.`);
    return v;
  };
  const kg = (k, label, allowZero = false) => {
    const str = String(input[k] ?? "").trim();
    if (allowZero && (str === "" || str === "0")) return 0;
    const v = parseKg(str);
    if (!v) throw new EntryError(`Enter a valid ${label} in kg.`);
    return v;
  };
  const sizes = String(input.quickSizes ?? "")
    .split(/[,\s]+/)
    .filter(Boolean)
    .map(parseKg);
  if (sizes.some((x) => !x) || sizes.length > 10) throw new EntryError("Quick sizes: list up to 10 weights in kg, separated by commas, e.g. 9, 14, 19.");
  const out = {
    sellCents: money("sell", "selling price"),
    baseBuyCents: money("baseBuy", "normal buying price"),
    bulkBuyCents: money("bulkBuy", "bulk buying price"),
    bulkMinCkg: kg("bulkMinKg", "bulk threshold"),
    tankCkg: kg("tankKg", "tank size"),
    openingStockCkg: kg("openingStockKg", "opening stock", true),
    openingStockCostCents: money("openingStockCost", "opening stock cost"),
    lowStockCkg: kg("lowStockKg", "low-stock warning level", true),
    quickSizesCkg: sizes.length ? [...new Set(sizes)].sort((a, b) => a - b) : DEFAULT_SETTINGS.quickSizesCkg,
  };
  if (out.bulkBuyCents > out.baseBuyCents) throw new EntryError("The bulk price should not be higher than the normal buying price.");
  return out;
}
