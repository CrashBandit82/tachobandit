'use strict';

// Driving and rest time check for a driver card ("Kontrolle").
// EU Reg. 561/2006 with the severity classes of Annex III Dir. 2006/22/EC (Reg. 2016/403)
// and the Austrian fine ranges for drivers (KFG §134, WKO overview "Strafen in Österreich"),
// plus Austrian working time rules for employed drivers (AZG §13b, §13c, §14).
// Simplified on purpose: no ferry/train, team driving, stopping-place or 12-day exceptions,
// no compensation of reduced weekly rests; time without card counts as rest.
// All times are minutes since the epoch (UTC); EU weeks are Mon–Sun UTC, AZG uses Vienna time.

const H = 60;
const MONDAY0 = 4 * 1440; // 1970-01-05 was a Monday
const weekOf = t => Math.floor((t - MONDAY0) / 10080);
const KFG = { MI: 'Abmahnung bis 5.000 €', SI: '200 bis 5.000 €', VSI: '300 bis 5.000 €', MSI: '400 bis 5.000 €' };
// steps: [[minimum value, class], …] ascending; null below the first step
const grade = (v, steps) => steps.reduce((c, [min, s]) => v >= min ? s : c, null);

// card days → merged list {a, b, k} with k = R(est) A(vailability) W(ork) D(riving); gaps count as rest
function timeline(days) {
  const raw = [];
  days.forEach(d => {
    const base = Date.parse(d.date.slice(0, 10) + 'T00:00:00Z') / 6e4;
    d.slots.forEach(sl => sl.segs.forEach(s => raw.push({ a: base + s.from, b: base + s.to, k: s.card ? 'RAWD'[s.type] : 'R' })));
  });
  raw.sort((x, y) => x.a - y.a);
  const tl = [];
  raw.forEach(s => {
    const p = tl[tl.length - 1];
    if (p && s.a > p.b) tl.push({ a: p.b, b: s.a, k: 'R' });
    const q = tl[tl.length - 1];
    if (q && q.k === s.k && q.b >= s.a) q.b = Math.max(q.b, s.b);
    else tl.push({ ...s, a: q ? Math.max(s.a, q.b) : s.a });
  });
  return tl.filter(s => s.b > s.a);
}

const sumKind = (tl, a, b, kinds) =>
  tl.reduce((t, s) => kinds.includes(s.k) ? t + Math.max(0, Math.min(b, s.b) - Math.max(a, s.a)) : t, 0);

// Daily working periods: each ends with the first rest inside the 24 h window after the previous
// rest that is long enough (≥ 9 h inside the window, or 3 h + 9 h split); otherwise with the longest rest.
function periods(tl, rests, end) {
  const out = [];
  const first = rests.find(r => r.len >= 9 * H);
  if (!first) return out;
  let t0 = first.b;
  while (t0 < end) {
    const we = t0 + 24 * H;
    const cand = rests.filter(r => r.a >= t0 && r.a < we);
    let chosen = null, type = null, part1 = false;
    for (const r of cand) {
      const eff = Math.min(r.b, we) - r.a;
      if (eff >= 9 * H) { chosen = r; type = eff >= 11 * H ? 'regular' : part1 ? 'split' : 'reduced'; break; }
      if (r.len >= 3 * H) part1 = true;
    }
    if (!chosen) {
      if (we >= end) { out.push({ a: t0, b: end, open: true }); break; }
      chosen = cand.reduce((m, r) => !m || Math.min(r.b, we) - r.a > Math.min(m.b, we) - m.a ? r : m, null)
        || rests.find(r => r.a >= we);
      if (!chosen) { out.push({ a: t0, b: end, open: true }); break; }
      type = 'short';
    }
    out.push({ a: t0, b: chosen.a, rest: chosen, eff: Math.max(0, Math.min(chosen.b, we) - chosen.a), type });
    t0 = chosen.b;
  }
  return out;
}

// Vienna wall-clock offset (minutes) at time t
const viennaFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Vienna', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const offsets = new Map(); // per UTC hour; DST switches on full hours
function viennaOffset(t) {
  const h = Math.floor(t / 60);
  if (!offsets.has(h)) {
    const p = Object.fromEntries(viennaFmt.formatToParts(new Date(h * 36e5)).map(x => [x.type, x.value]));
    offsets.set(h, Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute) / 6e4 - h * 60);
  }
  return offsets.get(h);
}

function analyze(days) {
  const tl = timeline(days);
  if (!tl.length) return [];
  const end = tl[tl.length - 1].b;
  const lastWork = [...tl].reverse().find(s => s.k !== 'R')?.b ?? end;
  const rests = tl.filter(s => s.k === 'R').map(s => ({ a: s.a, b: s.b, len: s.b - s.a }));
  const out = [];
  const eu = (at, rule, title, value, limit, sev, note) => out.push({ law: 'EU', at, rule, title, value, limit, sev, fine: KFG[sev] || KFG.MI, note });
  const azg = (at, rule, title, value, limit, note) => out.push({ law: 'AZG', at, rule, title, value, limit, sev: null, fine: 'trifft den Arbeitgeber (AZG §28)', note });

  // Art. 7: max. 4.5 h driving, then 45 min break (or 15 + 30)
  let acc = 0, part = false, from = null;
  const flush = () => {
    if (acc > 270) eu(from, 'Art. 7 VO 561/2006', 'Lenkzeit ohne Fahrtunterbrechung', acc, 270, grade(acc, [[271, 'MI'], [300, 'SI'], [360, 'VSI']]));
    acc = 0; part = false; from = null;
  };
  tl.forEach(s => {
    const len = s.b - s.a;
    if (s.k === 'D') { if (from === null) from = s.a; acc += len; }
    else if (s.k === 'R') {
      if (len >= 45 || (part && len >= 30)) flush();
      else if (len >= 15) part = true;
    }
  });
  flush();

  // Art. 6 (1), Art. 8 (2): daily driving and daily rest
  const ps = periods(tl, rests, end);
  const ext = {};
  let reduced = 0;
  ps.forEach(p => {
    const drive = sumKind(tl, p.a, p.b, 'D');
    if (drive > 540) {
      const w = weekOf(p.a);
      if ((ext[w] || 0) < 2) {
        ext[w] = (ext[w] || 0) + 1;
        if (drive > 600) eu(p.a, 'Art. 6 Abs. 1 VO 561/2006', 'Tägliche Lenkzeit (verlängert 10 h)', drive, 600,
          grade(drive, [[601, 'MI'], [660, 'SI'], [720, 'VSI'], [900, 'MSI']]));
      } else eu(p.a, 'Art. 6 Abs. 1 VO 561/2006', 'Tägliche Lenkzeit (9 h, Verlängerung diese Woche schon 2× genutzt)', drive, 540,
        grade(drive, [[541, 'MI'], [600, 'SI'], [660, 'VSI'], [810, 'MSI']]));
    }
    if (p.open) return;
    if (p.type === 'reduced' || p.type === 'short') {
      const allowed = reduced < 3;
      reduced++;
      if (p.type === 'short' || !allowed) {
        const limit = allowed ? 540 : 660, short = limit - p.eff;
        eu(p.rest.a, 'Art. 8 Abs. 2 VO 561/2006', allowed ? 'Reduzierte tägliche Ruhezeit unter 9 h' : 'Tägliche Ruhezeit unter 11 h (schon 3 reduzierte seit der Wochenruhe)',
          p.eff, limit, grade(short, allowed ? [[1, 'MI'], [61, 'SI'], [121, 'VSI']] : [[1, 'MI'], [61, 'SI'], [151, 'VSI']]),
          'innerhalb von 24 h nach Ende der vorigen Ruhezeit');
      }
    }
    if (p.rest.len >= 24 * H) reduced = 0;
  });

  // Art. 6 (2), (3): weekly driving 56 h, two weeks 90 h
  const weekDrive = {};
  tl.filter(s => s.k === 'D').forEach(s => {
    for (let t = s.a; t < s.b;) {
      const w = weekOf(t), wEnd = MONDAY0 + (w + 1) * 10080, e = Math.min(s.b, wEnd);
      weekDrive[w] = (weekDrive[w] || 0) + e - t;
      t = e;
    }
  });
  Object.keys(weekDrive).map(Number).forEach(w => {
    const at = MONDAY0 + w * 10080, d = weekDrive[w], two = d + (weekDrive[w - 1] || 0);
    if (d > 3360) eu(at, 'Art. 6 Abs. 2 VO 561/2006', 'Wöchentliche Lenkzeit', d, 3360, grade(d, [[3361, 'MI'], [3600, 'SI'], [3900, 'VSI'], [4200, 'MSI']]));
    if (two > 5400) eu(at, 'Art. 6 Abs. 3 VO 561/2006', 'Lenkzeit in zwei aufeinanderfolgenden Wochen', two, 5400, grade(two, [[5401, 'MI'], [6000, 'SI'], [6300, 'VSI'], [6750, 'MSI']]));
  });

  // Art. 8 (6): weekly rest at the latest after 6 × 24 h; regular 45 h, reduced 24 h
  const wr = rests.filter(r => r.len >= 24 * H);
  wr.forEach((r, i) => {
    const deadline = r.b + 144 * H, next = wr[i + 1];
    const late = (next ? Math.min(next.a, lastWork) : lastWork) - deadline;
    if (late > 0) eu(deadline, 'Art. 8 Abs. 6 VO 561/2006', 'Wöchentliche Ruhezeit nicht spätestens nach 6 × 24 h', 144 * H + late, 144 * H,
      grade(late, [[1, 'MI'], [181, 'SI'], [721, 'VSI']]), 'Wert = Zeit seit Ende der letzten Wochenruhe');
    const prev = wr[i - 1];
    if (prev && prev.len < 45 * H && r.len < 45 * H && r.b < end)
      eu(r.a, 'Art. 8 Abs. 6 VO 561/2006', 'Zwei reduzierte Wochenruhezeiten hintereinander', r.len, 45 * H,
        grade(45 * H - r.len, [[1, 'MI'], [181, 'SI'], [541, 'VSI']]), 'Ausnahme für den grenzüberschreitenden Güterverkehr und Ausgleich nicht geprüft');
  });

  // AZG (Austria, employed drivers): working time = driving + other work + availability
  ps.forEach(p => {
    const segs = tl.filter(s => s.b > p.a && s.a < p.b).map(s => ({ ...s, a: Math.max(s.a, p.a), b: Math.min(s.b, p.b) }));
    const work = sumKind(segs, p.a, p.b, 'AWD');
    // §13c: ≥ 30 min break if > 6 h, ≥ 45 min if > 9 h, parts ≥ 15 min, at the latest after 6 h
    const need = work > 9 * H ? 45 : work > 6 * H ? 30 : 0;
    if (need) {
      let w = 0, br = 0, lateAt = null;
      const firstWork = segs.find(s => s.k !== 'R')?.a, lastW = [...segs].reverse().find(s => s.k !== 'R')?.b;
      segs.forEach(s => {
        if (s.k !== 'R') {
          if (br < 30 && w + (s.b - s.a) > 6 * H && lateAt === null) lateAt = s.a + (6 * H - w);
          w += s.b - s.a;
        } else if (s.a > firstWork && s.b < lastW && s.b - s.a >= 15) br += s.b - s.a;
      });
      if (br < need) azg(p.a, 'AZG §13c', 'Ruhepause zu kurz', br, need, `Arbeitszeit ${Math.floor(work / 60)}:${String(work % 60).padStart(2, '0')} h; Teile unter 15 min zählen nicht`);
      else if (lateAt !== null && !p.open) azg(lateAt, 'AZG §13c', 'Ruhepause nicht spätestens nach 6 h Arbeitszeit', 6 * H, 6 * H, 'mindestens 30 min Pause vor Ablauf von 6 h');
    }
    // §14: night work (00–04 Vienna time) → daily working time max. 10 h
    let night = false;
    segs.forEach(s => {
      if (s.k === 'R' || night) return;
      for (let t = s.a; t < s.b && !night; t += 15) {
        const m = ((t + viennaOffset(t)) % 1440 + 1440) % 1440;
        if (m < 240) night = true;
      }
    });
    if (night && work > 10 * H) azg(p.a, 'AZG §14', 'Tagesarbeitszeit über 10 h trotz Nachtarbeit (00–04 Uhr)', work, 10 * H);
  });
  // §13b: weekly working time max. 60 h (Mon–Sun, Vienna time)
  const weekWork = {};
  tl.filter(s => s.k !== 'R').forEach(s => {
    for (let t = s.a; t < s.b; t++) {
      const w = weekOf(t + viennaOffset(t));
      weekWork[w] = (weekWork[w] || 0) + 1;
    }
  });
  Object.keys(weekWork).map(Number).forEach(w => {
    if (weekWork[w] > 60 * H) azg(MONDAY0 + w * 10080, 'AZG §13b', 'Wöchentliche Arbeitszeit über 60 h', weekWork[w], 60 * H, 'Woche Mo–So, österreichische Zeit');
  });

  return out.sort((x, y) => y.at - x.at);
}
