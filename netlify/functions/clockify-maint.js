// Clockify feed for the maintenance scope page (/scope).
//
// Returns aggregated hours for the "LiveHealthyChi Maint 1" project so scope.html
// can render a live burn-down against the $5,000 / 67-hour prepaid block.
//
// CLOCKIFY_API_KEY is read from Netlify's environment — it is never sent to the
// browser and must never be committed (this repo is public).

const WORKSPACE_ID = '655792ef053d7164aefcb136';
const PROJECT_ID   = '6a5a7c7cb5bd96d29537fa61'; // LiveHealthyChi Maint 1

// Amendment No. 1 financial terms — see /sow-amendment
const BLOCK_HOURS  = 67;
const RATE         = 75;
// The contract states $5,000 for 67 hours at $75/hr. 67 x 75 is $5,025, so the
// $5,000 figure governs the money and the 67 hours govern the time.
const BLOCK_AMOUNT = 5000;
const ALLOCATION  = [
  { key: 'chw',     task: 'CHW Training Set',    label: 'CHW training set',     hours: 20, amount: 1500 },
  { key: 'ongoing', task: 'Ongoing Maintenance', label: 'Ongoing maintenance',  hours: 47, amount: 3500 },
];

const hrs = (seconds) => Math.round((seconds / 3600) * 100) / 100;

exports.handler = async () => {
  const key = process.env.CLOCKIFY_API_KEY;
  if (!key) {
    return json(500, { error: 'CLOCKIFY_API_KEY is not set on this site.' });
  }

  try {
    const res = await fetch(
      `https://reports.api.clockify.me/v1/workspaces/${WORKSPACE_ID}/reports/detailed`,
      {
        method: 'POST',
        headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dateRangeStart: '2026-01-01T00:00:00Z',
          dateRangeEnd:   '2026-12-31T23:59:59Z',
          projects: { ids: [PROJECT_ID], contains: 'CONTAINS' },
          detailedFilter: { page: 1, pageSize: 1000, sortColumn: 'DATE', sortOrder: 'DESCENDING' },
          exportType: 'JSON',
        }),
      }
    );

    if (!res.ok) {
      return json(502, { error: `Clockify returned ${res.status}.` });
    }

    const data = await res.json();
    const raw  = data.timeentries || [];

    // Roll each entry up to a single day so the log reads like a work log,
    // not a timer log (short same-day entries are common).
    const byDay = new Map();
    for (const e of raw) {
      const date = e.timeInterval.start.slice(0, 10);
      const task = e.taskName || null;
      const id   = `${date}|${task || ''}`;
      const day  = byDay.get(id) || { date, task, seconds: 0, notes: [] };
      day.seconds += e.timeInterval.duration;
      // Descriptions that are just the date restate the column — skip them.
      const note = (e.description || '').trim();
      if (note && !/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(note) && !day.notes.includes(note)) {
        day.notes.push(note);
      }
      byDay.set(id, day);
    }

    const entries = [...byDay.values()]
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((d) => ({ date: d.date, task: d.task, hours: hrs(d.seconds), note: d.notes.join(' · ') }));

    const usedSeconds = raw.reduce((sum, e) => sum + e.timeInterval.duration, 0);
    const usedHours   = hrs(usedSeconds);

    const buckets = ALLOCATION.map((a) => {
      const used = hrs(
        raw.filter((e) => e.taskName === a.task).reduce((s, e) => s + e.timeInterval.duration, 0)
      );
      return { ...a, usedHours: used, usedAmount: Math.round(used * RATE * 100) / 100 };
    });

    const categorized   = buckets.reduce((s, b) => s + b.usedHours, 0);
    const uncategorized = Math.round((usedHours - categorized) * 100) / 100;

    return json(200, {
      project: 'LiveHealthyChi Maint 1',
      blockHours: BLOCK_HOURS,
      rate: RATE,
      blockAmount: BLOCK_AMOUNT,
      usedHours,
      usedAmount: Math.round(usedHours * RATE * 100) / 100,
      remainingHours: Math.round((BLOCK_HOURS - usedHours) * 100) / 100,
      remainingAmount: Math.round((BLOCK_AMOUNT - usedHours * RATE) * 100) / 100,
      percentUsed: Math.round((usedHours / BLOCK_HOURS) * 1000) / 10,
      buckets,
      uncategorizedHours: uncategorized,
      entryCount: raw.length,
      firstEntry: entries.length ? entries[entries.length - 1].date : null,
      lastEntry:  entries.length ? entries[0].date : null,
      entries,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    return json(502, { error: 'Could not reach Clockify.' });
  }
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      // Cheap guard against hammering the Clockify API on every page load.
      'Cache-Control': 'public, max-age=300',
    },
    body: JSON.stringify(body),
  };
}
