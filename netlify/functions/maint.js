// Time feed for the maintenance scope page (/scope).
//
// Replaces clockify-maint.js. Clockify was retired on 29 Sept 2026 and stopped
// receiving entries that day; the hours now live in Time at time.orbisdesign.com.
// The response shape is deliberately identical to the old function so scope.html
// needs no change — only the fetch URL in the page moves from
// /.netlify/functions/clockify-maint to /.netlify/functions/maint.
//
// TIME_API_KEY is read from Netlify's environment. It is never sent to the
// browser and must never be committed — this repo is public.
//
// What Time serves here is already client-safe by construction: its burn-down
// endpoint returns the cleared client-facing line for each entry, never the
// internal note, and withholds money entirely for anything that is not a
// pre-paid block. See apps/time/app/main.py in the SOUL repo.

const TIME_BASE = 'https://time.orbisdesign.com';
const PROJECT   = 'livehealthychi-maint-1';

// Amendment No. 1 financial terms — see /sow-amendment. Time holds these too
// (block hours, price and rate), but they are repeated here so the page still
// renders its headline numbers if the feed is briefly unavailable.
const BLOCK_HOURS  = 67;
const RATE         = 75;
const BLOCK_AMOUNT = 5000;

// The CHW / Ongoing split from the amendment. Clockify never had a single entry
// tagged to either task, so every hour has always shown as unfiled. Kept so the
// page keeps describing the agreement; entries acquire a bucket in Time the
// moment work is assigned to one.
const ALLOCATION = [
  { key: 'chw',     task: 'CHW training set',     label: 'CHW training set',    hours: 20, amount: 1500 },
  { key: 'ongoing', task: 'Ongoing maintenance',  label: 'Ongoing maintenance', hours: 47, amount: 3500 },
];

const r2 = (n) => Math.round(n * 100) / 100;

exports.handler = async () => {
  const key = process.env.TIME_API_KEY;
  if (!key) {
    return json(500, { error: 'TIME_API_KEY is not set on this site.' });
  }

  try {
    const res = await fetch(
      `${TIME_BASE}/api/report/burndown?project=${PROJECT}&log=365`,
      {
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: 'application/json',
          // Named honestly: the request crosses a CDN that screens unknown clients.
          'User-Agent': 'livehealthychi-scope/1.0 (+https://livehealthychi.com/scope)',
        },
      }
    );

    if (!res.ok) {
      return json(502, { error: `Time returned ${res.status}.` });
    }

    const payload = await res.json();
    const p = (payload.projects || [])[0];
    if (!p) {
      return json(502, { error: 'Time returned no project.' });
    }

    const usedHours = r2(p.used?.hours ?? 0);

    // The work log, already client-safe. Days without a cleared line are left
    // out rather than shown with internal shorthand — a blank is honest, an
    // internal note in front of a client is not.
    const entries = (p.log || [])
      .filter((w) => w.summary)
      .map((w) => ({
        date: w.date,
        task: w.part || null,
        hours: r2(w.hours ?? 0),
        note: w.summary,
      }));

    const buckets = ALLOCATION.map((a) => {
      const from = (p.allocation || []).find((x) => x.name === a.task);
      const used = r2(from?.used ?? 0);
      return { ...a, usedHours: used, usedAmount: r2(used * RATE) };
    });

    const categorized   = buckets.reduce((s, b) => s + b.usedHours, 0);
    const uncategorized = r2(usedHours - categorized);

    return json(200, {
      project: p.project || 'LiveHealthyChi Maint 1',
      blockHours: BLOCK_HOURS,
      rate: RATE,
      blockAmount: BLOCK_AMOUNT,
      usedHours,
      usedAmount: r2(usedHours * RATE),
      remainingHours: r2(BLOCK_HOURS - usedHours),
      remainingAmount: r2(BLOCK_AMOUNT - usedHours * RATE),
      percentUsed: Math.round((usedHours / BLOCK_HOURS) * 1000) / 10,
      buckets,
      uncategorizedHours: uncategorized,
      entryCount: p.used?.entries ?? entries.length,
      firstEntry: p.firstDay ?? (entries.length ? entries[entries.length - 1].date : null),
      lastEntry:  p.lastDay  ?? (entries.length ? entries[0].date : null),
      entries,
      // Hours are counted on the slice basis: when two projects run in the same
      // hour that hour is split between them, so no client is ever charged for
      // time another client is also being charged for.
      hoursBasis: p.hoursBasis || 'slice',
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    return json(502, { error: 'Could not reach Time.' });
  }
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
    },
    body: JSON.stringify(body),
  };
}
