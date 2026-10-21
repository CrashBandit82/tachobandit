'use strict';

// ---- Lookup tables (EU 2016/799 Annex 1C) ----
const ACT = ['Ruhe', 'Bereitschaft', 'Arbeit', 'Lenken'];
const NATIONS = ['', 'A', 'AL', 'AND', 'ARM', 'AZ', 'B', 'BG', 'BIH', 'BY', 'CH', 'CY', 'CZ', 'D', 'DK', 'E',
  'EST', 'F', 'FIN', 'FL', 'FO', 'UK', 'GE', 'GR', 'H', 'HR', 'I', 'IRL', 'IS', 'KZ', 'L', 'LT', 'LV', 'M', 'MC',
  'MD', 'MK', 'N', 'NL', 'P', 'PL', 'RO', 'RSM', 'RUS', 'S', 'SK', 'SLO', 'TM', 'TR', 'UA', 'V', 'YU', 'MNE', 'SRB',
  'UZ', 'TJ'];
const EVENTS = {
  0x00: 'Ereignis', 0x01: 'Ungültige Karte gesteckt', 0x02: 'Kartenkonflikt', 0x03: 'Zeitüberlappung',
  0x04: 'Fahren ohne passende Karte', 0x05: 'Karte während der Fahrt gesteckt', 0x06: 'Letzter Kartenvorgang nicht korrekt abgeschlossen',
  0x07: 'Geschwindigkeitsüberschreitung', 0x08: 'Unterbrechung der Stromversorgung', 0x09: 'Fehler Bewegungsdaten',
  0x0A: 'Widerspruch Fahrzeugbewegung', 0x0B: 'Zeitkonflikt (GNSS / interne Uhr)', 0x0C: 'Kommunikationsfehler Fernabfrage',
  0x0D: 'Keine GNSS-Position', 0x0E: 'Kommunikationsfehler externes GNSS',
  0x10: 'Sicherheitsverletzung', 0x11: 'Authentisierungsfehler Weg-/Geschwindigkeitsgeber', 0x12: 'Authentisierungsfehler Karte',
  0x13: 'Unerlaubter Wechsel des Gebers', 0x14: 'Integritätsfehler Kartendaten', 0x15: 'Integritätsfehler gespeicherte Daten',
  0x16: 'Fehler interne Datenübertragung', 0x17: 'Unbefugtes Öffnen des Gehäuses', 0x18: 'Hardware-Sabotage',
  0x19: 'Manipulation GNSS erkannt', 0x1A: 'Authentisierungsfehler externes GNSS', 0x1B: 'Zertifikat externes GNSS abgelaufen',
  0x30: 'Gerätefehler', 0x31: 'Interner Fehler Kontrollgerät', 0x32: 'Druckerfehler', 0x33: 'Anzeigefehler',
  0x34: 'Fehler beim Herunterladen', 0x35: 'Geberfehler', 0x36: 'Fehler interner GNSS-Empfänger', 0x37: 'Fehler externes GNSS',
  0x38: 'Fehler Fernkommunikation', 0x39: 'Fehler ITS-Schnittstelle', 0x40: 'Kartenfehler',
};
const CALIB = { 1: 'Aktivierung', 2: 'Erstinstallation', 3: 'Einbau', 4: 'Nachprüfung', 5: 'Kennzeichen (Unternehmen)', 6: 'Zeitjustierung' };

// ---- Helpers ----
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nation = n => (n == null || n === 0) ? '' : (NATIONS[n] || (n === 0xFD ? 'EC' : n === 0xFE ? 'EUR' : n === 0xFF ? 'WLD' : '#' + n));
const pad = n => String(n).padStart(2, '0');
const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

// ---- Time zone: UTC (as stored by the tachograph) or the browser's local zone ----
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
let tzMode = (() => { try { return localStorage.getItem('tz') || 'UTC'; } catch { return 'UTC'; } })();
const zone = () => tzMode === 'local' ? LOCAL_TZ : 'UTC';
const tzFmt = {};
// wall clock of a timestamp (ms) in the selected zone
function clock(ms) {
  const f = tzFmt[zone()] ||= new Intl.DateTimeFormat('en-CA', { timeZone: zone(), year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute };
}
const dayKey = ms => { const c = clock(ms); return `${c.y}-${pad(c.mo)}-${pad(c.d)}`; };
// start (ms) of a calendar day in the selected zone, DST-safe
function midnight(key) {
  const [y, mo, d] = key.split('-').map(Number);
  let t = Date.UTC(y, mo - 1, d);
  for (let i = 0; i < 2; i++) {
    const c = clock(t);
    t -= Date.UTC(c.y, c.mo - 1, c.d, c.h, c.mi) - Date.UTC(y, mo - 1, d);
  }
  return t;
}

function fmtDT(iso) {
  if (!iso) return '';
  const c = clock(Date.parse(iso));
  return `${pad(c.d)}.${pad(c.mo)}.${c.y} ${pad(c.h)}:${pad(c.mi)}`;
}
// calendar dates (expiry, birthday, day headers) are not shifted
function fmtD(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}
const hm = m => `${Math.floor(m / 60)}:${pad(m % 60)}`;
const reg = r => !r ? '' : typeof r === 'string' ? r.trim()
  : `${nation(r.vehicle_registration_nation)} ${(r.vehicle_registration_number || '').trim()}`.trim();
const holder = h => !h ? '' : `${(h.holder_first_names || '').trim()} ${(h.holder_surname || '').trim()}`.trim();
const cardNo = f => !f ? '' : f.full_card_number ? cardNo(f.full_card_number) : (f.card_number || '').trim();
const km = v => (v == null || v === '') ? '' : Number(v).toLocaleString('de-AT');
// zero-filled blocks (generation not present) contain neither dates nor non-empty strings
const hasData = o => { const j = JSON.stringify(o ?? null).replace(/\\u0000/g, ''); return /"\d{4}-\d\d-\d\dT/.test(j) || /:"[^"]*[^" ][^"]*"/.test(j); };
// first block of a list (Gen2 V2, Gen2, Gen1 …) that actually contains data
const pick = (...list) => list.find(hasData);

// all nested objects that satisfy pred
function collect(o, pred, out = []) {
  if (Array.isArray(o)) o.forEach(x => collect(x, pred, out));
  else if (o && typeof o === 'object') {
    if (pred(o)) out.push(o);
    Object.values(o).forEach(x => collect(x, pred, out));
  }
  return out;
}

function segments(changes) {
  const c = [...changes].sort((a, b) => a.minutes - b.minutes);
  return c.map((x, i) => ({
    from: x.minutes, to: i + 1 < c.length ? c[i + 1].minutes : 1440,
    type: x.work_type, card: x.card_present, team: x.team,
  })).filter(s => s.to > s.from);
}
// t[0..3] per activity with card inserted, t[4] = time without card (no reliable activity)
function totals(segs) {
  const t = [0, 0, 0, 0, 0];
  segs.forEach(s => { t[s.card ? s.type : 4] += s.to - s.from; });
  return t;
}

// ---- Normalisation: card and VU files into one shape ----
function normCard(d) {
  const g = base => pick(d[base + '_2'], d[base + '_1']);
  const id = g('card_identification_and_driver_card_holder_identification') || {};
  const ci = id.card_identification || {};
  const hi = id.driver_card_holder_identification || {};
  const lic = g('card_driving_licence_information') || {};
  const b = hi.card_holder_birth_date;
  const act = g('card_driver_activity');
  const days = (act?.decoded_activity_daily_records || []).filter(r => r.activity_record_date).map(r => ({
    date: r.activity_record_date, km: r.activity_day_distance,
    slots: [{ label: '', segs: segments(r.activity_change_info || []) }],
  })).sort((a, b) => b.date.localeCompare(a.date));
  const veh = (g('card_vehicles_used')?.card_vehicle_records || []).filter(v => v.vehicle_first_use)
    .sort((a, b) => b.vehicle_first_use.localeCompare(a.vehicle_first_use));
  const places = (g('card_place_daily_work_period')?.place_records || []).filter(p => p.entry_time);
  const ev = collect(g('card_event_data'), o => 'event_type' in o && o.event_begin_time).map(e => ({
    type: e.event_type, begin: e.event_begin_time, end: e.event_end_time, info: reg(e.event_vehicle_registration),
  }));
  const fa = collect(g('card_fault_data'), o => 'fault_type' in o && o.fault_begin_time).map(e => ({
    type: e.fault_type, begin: e.fault_begin_time, end: e.fault_end_time, info: reg(e.fault_vehicle_registration),
  }));
  return {
    kind: 'card', title: holder(hi.card_holder_name) || 'Fahrerkarte',
    sub: `Karte ${nation(ci.card_issuing_member_state)} ${(ci.card_number || '').trim()}`,
    facts: [
      ['Geburtsdatum', b ? `${pad(b.day)}.${pad(b.month)}.${b.year}` : ''],
      ['Kartennummer', (ci.card_number || '').trim()],
      ['Ausgestellt von', `${(ci.card_issuing_authority_name || '').trim()} (${nation(ci.card_issuing_member_state)})`],
      ['Gültig bis', fmtD(ci.card_expiry_date)],
      ['Führerschein', `${(lic.driving_licence_number || '').trim()} ${nation(lic.driving_licence_issuing_nation)}`],
      ['Tage gespeichert', days.length],
    ],
    days, veh, places, events: [...ev, ...fa],
  };
}

function normVu(d) {
  const acts = [d.vu_activities_2_v2, d.vu_activities_2, d.vu_activities_1].find(a => a?.some(hasData)) || [];
  let days = acts.filter(hasData).map(el => {
    const date = el.time_real || el.date_of_day_downloaded_record_array?.records?.[0];
    const odo = el.odometer_value_midnight ?? el.odometer_value_midnight_record_array?.records?.[0];
    const changes = el.vu_activity_daily_data?.activity_change_info || el.vu_activity_daily_record_array?.records || [];
    const slots = [true, false].map(drv => ({
      label: drv ? 'Fahrer' : 'Beifahrer', segs: segments(changes.filter(c => c.driver === drv)),
    })).filter(s => s.segs.length && !(s.label === 'Beifahrer' && s.segs.every(x => !x.card)));
    return { date, odo, slots };
  }).filter(x => x.date).sort((a, b) => a.date.localeCompare(b.date));
  days.forEach((x, i) => { const n = days[i + 1]; x.km = n && n.odo != null && x.odo != null ? n.odo - x.odo : null; });

  const iw = collect(acts, o => 'card_insertion_time' in o && o.card_insertion_time);
  const seen = new Set();
  const cards = iw.filter(c => { const k = c.card_insertion_time + cardNo(c.full_card_number || c.full_card_number_and_generation) + c.card_slot_number; return !seen.has(k) && seen.add(k); })
    .sort((a, b) => b.card_insertion_time.localeCompare(a.card_insertion_time));
  const places = collect(acts, o => 'place_record' in o || 'place_auth_record' in o).map(o => ({
    ...(o.place_record || o.place_auth_record), card: cardNo(o.full_card_number || o.full_card_number_and_generation),
  })).filter(p => p.entry_time);

  const ov = pick(d.vu_overview_2_v2, d.vu_overview_2, d.vu_overview_1) || {};
  const vin = ov.vehicle_identification_number || ov.vehicle_identification_number_record_array?.records?.[0] || '';
  const plate = reg(ov.vehicle_registration_identification || ov.vehicle_registration_identification_record_array?.records?.[0]
    || ov.vehicle_registration_number_record_array?.records?.[0]);
  const period = collect(ov, o => 'min_downloadable_time' in o)[0] || {};
  const evBlocks = [d.vu_events_and_faults_2_v2, d.vu_events_and_faults_2, d.vu_events_and_faults_1].find(a => a?.some(hasData));
  const events = collect(evBlocks, o => ('event_type' in o && o.event_begin_time) || ('fault_type' in o && o.fault_begin_time)).map(e => ({
    type: e.event_type ?? e.fault_type, begin: e.event_begin_time || e.fault_begin_time, end: e.event_end_time || e.fault_end_time,
    info: cardNo(e.card_number_driver_slot_begin || e.card_number_and_gen_driver_slot_begin) +
      (e.similar_events_number > 1 ? ` (${e.similar_events_number}× ähnlich)` : ''),
  }));
  const tech = [d.vu_technical_data_2_v2, d.vu_technical_data_2, d.vu_technical_data_1].find(a => a?.some(hasData));
  const ident = collect(tech, o => 'vu_manufacturer_name' in o && o.vu_manufacturer_name)[0] || {};
  const calib = collect(tech, o => 'calibration_purpose' in o && (o.workshop_name || '').trim())
    .sort((a, b) => (b.new_time_value || '').localeCompare(a.new_time_value || ''));
  return {
    kind: 'vu', title: plate || 'Fahrzeug', sub: vin ? `FIN ${vin}` : '',
    facts: [
      ['Kennzeichen', plate], ['FIN', vin],
      ['Daten von', fmtDT(period.min_downloadable_time)], ['Daten bis', fmtDT(period.max_downloadable_time)],
      ['Kontrollgerät', `${(ident.vu_manufacturer_name || '').trim()} ${typeof ident.vu_part_number === 'string' ? ident.vu_part_number.trim() : ''}`],
      ['Nächste Prüfung', fmtD(calib[0]?.next_calibration_date)],
    ],
    days: days.reverse(), cards, places, events, calib,
  };
}

// Days cut at midnight of the selected zone. Source days are UTC days; every segment
// gets elapsed minutes since the zone's midnight (from/to), clock labels (fl/tl) and the
// day length (23/25 h on DST changes). Day km stay with the same calendar date.
function zonedDays(days) {
  const out = new Map();
  const bucket = key => {
    if (!out.has(key)) {
      const m0 = midnight(key), m1 = midnight(dayKey(m0 + 25 * 3600e3));
      out.set(key, { date: key + 'T00:00:00Z', m0, len: (m1 - m0) / 6e4, km: null, slots: [] });
    }
    return out.get(key);
  };
  const label = (day, min) => { if (min >= day.len) return '24:00'; const c = clock(day.m0 + min * 6e4); return `${pad(c.h)}:${pad(c.mi)}`; };
  days.forEach(src => {
    const base = Date.parse(src.date.slice(0, 10) + 'T00:00:00Z');
    const own = bucket(dayKey(base + 12 * 3600e3));
    if (src.km != null) own.km = (own.km || 0) + src.km;
    src.slots.forEach(sl => sl.segs.forEach(s => {
      let a = base + s.from * 6e4;
      const b = base + s.to * 6e4;
      while (a < b) {
        const day = bucket(dayKey(a)), end = Math.min(b, day.m0 + day.len * 6e4);
        let slot = day.slots.find(x => x.label === sl.label);
        if (!slot) day.slots.push(slot = { label: sl.label, segs: [] });
        slot.segs.push({ ...s, from: (a - day.m0) / 6e4, to: (end - day.m0) / 6e4 });
        a = end;
      }
    }));
  });
  const res = [...out.values()].filter(d => d.slots.length).sort((a, b) => b.date.localeCompare(a.date));
  res.forEach(d => {
    const order = days[0]?.slots.map(s => s.label) || [];
    d.slots.sort((x, y) => order.indexOf(x.label) - order.indexOf(y.label));
    d.slots.forEach(sl => {
      // rejoin pieces of one activity that were cut at the UTC day boundary
      sl.segs = sl.segs.sort((x, y) => x.from - y.from).reduce((acc, s) => {
        const p = acc[acc.length - 1];
        if (p && p.to === s.from && p.type === s.type && p.card === s.card && p.team === s.team) p.to = s.to;
        else acc.push(s);
        return acc;
      }, []);
      sl.segs.forEach(s => { s.fl = label(d, s.from); s.tl = label(d, s.to); });
    });
  });
  return res;
}

function verification(d) {
  // EF ICC / EF IC (chip identification) are not signed on the card
  const blocks = collect(d, o => 'verified' in o && hasData(o) && !('ic_identifier' in o) && !('ic_serial_number' in o));
  const ok = blocks.filter(b => b.verified).length;
  return { ok, total: blocks.length };
}

// ---- Rendering ----
let files = [], current = null, filter = 'all';

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok && r.status !== 204) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.status === 204 ? null : r.json();
}

async function loadList() {
  files = await api('/api/files');
  renderList();
}

function renderList() {
  const ul = $('#files');
  const shown = files.filter(f => filter === 'all' || f.kind === filter);
  ul.innerHTML = shown.map(f => `<li data-id="${f.id}" class="${current?.id === f.id ? 'sel' : ''}">
    <span class="k">${f.kind === 'vu' ? 'Fahrzeug' : 'Karte'}</span>${esc(f.name)}
    <div class="muted">hochgeladen ${fmtDT(f.uploaded)}</div></li>`).join('') ||
    '<li class="muted">Noch keine Dateien.</li>';
}

function bar(segs, len) {
  return `<div class="bar">${segs.map(s => `<b class="a${s.type}${s.card ? '' : ' nocard'}" style="left:${s.from / len * 100}%;width:${(s.to - s.from) / len * 100}%"
    title="${s.fl}–${s.tl} ${ACT[s.type]} (${hm(s.to - s.from)})${s.card ? '' : ' – ohne Karte'}"></b>`).join('')}</div>`;
}
const scale = `<div class="scale">${[0, 3, 6, 9, 12, 15, 18, 21, 24].map(h => `<span style="left:${h / 24 * 100}%">${h}</span>`).join('')}</div>`;
const legend = `<div class="legend">${ACT.map((a, i) => `<span><i style="background:var(--${['rest', 'avail', 'work', 'drive'][i]})"></i>${a}</span>`).join('')}
  <span><i class="nocard-key"></i>ohne Karte</span><span><i style="background:var(--none)"></i>keine Daten</span></div>`;

function monday(iso) {
  const d = new Date(iso.slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return d.toISOString();
}

function renderDays(n) {
  n.zdays = zonedDays(n.days);
  if (!n.zdays.length) return '<p class="empty">Keine Tätigkeiten gespeichert.</p>';
  let html = legend, week = null;
  const weekDrive = {};
  n.zdays.forEach(day => { const w = monday(day.date); weekDrive[w] = (weekDrive[w] || 0) + day.slots.reduce((s, sl) => s + totals(sl.segs)[3], 0); });
  n.zdays.forEach((day, i) => {
    const w = monday(day.date);
    if (w !== week) {
      week = w;
      const end = new Date(w); end.setUTCDate(end.getUTCDate() + 6);
      html += `<div class="week"><span>Woche ${fmtD(w)} – ${fmtD(end.toISOString())}</span>
        ${n.kind === 'card' ? `<span>Lenkzeit Woche: ${hm(weekDrive[w])} h</span>` : ''}</div>`;
    }
    const dt = new Date(day.date);
    const vio = (n.viol || []).filter(v => v.at * 6e4 >= day.m0 && v.at * 6e4 < day.m0 + day.len * 6e4);
    html += `<div class="day" data-i="${i}"><div class="date">${WD[dt.getUTCDay()]} ${fmtD(day.date)}${vio.length
      ? `<span class="vio" title="${esc(vio.map(v => v.title).join('\n'))}">⚠ ${vio.length}</span>` : ''}</div><div>`;
    day.slots.forEach(sl => {
      const t = totals(sl.segs);
      if (sl.label) html += `<div class="slot">${sl.label}</div>`;
      html += bar(sl.segs, day.len) + `<div class="sums">Lenken ${hm(t[3])} · Arbeit ${hm(t[2])} · Bereitschaft ${hm(t[1])} · Ruhe ${hm(t[0])}${t[4] ? ` · ohne Karte ${hm(t[4])}` : ''}</div>`;
    });
    html += `${scale}<div class="sums">${day.km != null ? km(day.km) + ' km' : ''}</div></div><div class="detail" hidden></div></div>`;
  });
  return html;
}

function dayDetail(day) {
  return day.slots.map(sl => `${sl.label ? `<h3>${sl.label}</h3>` : ''}<div class="tbl"><table>
    <tr><th>Von</th><th>Bis</th><th>Tätigkeit</th><th class="num">Dauer</th><th></th></tr>
    ${sl.segs.map(s => `<tr><td>${s.fl}</td><td>${s.tl}</td><td>${ACT[s.type]}</td><td class="num">${hm(s.to - s.from)}</td>
      <td class="muted">${s.card ? '' : 'ohne Karte'}${s.team ? ' Team' : ''}</td></tr>`).join('')}</table></div>`).join('');
}

const table = (head, rows) => rows.length
  ? `<div class="tbl"><table><tr>${head.map(h => `<th${h.endsWith(' km') || h === 'km' ? ' class="num"' : ''}>${h}</th>`).join('')}</tr>
    ${rows.map(r => `<tr>${r.map((c, i) => `<td${head[i].endsWith(' km') || head[i] === 'km' ? ' class="num"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('')}</table></div>`
  : '<p class="empty">Keine Einträge.</p>';

const SEV = { MSI: 'schwerst', VSI: 'sehr schwer', SI: 'schwer', MI: 'geringfügig' };
function renderCtrl(viol) {
  const count = k => viol.filter(v => (v.sev || v.law) === k).length;
  const chips = ['MSI', 'VSI', 'SI', 'MI'].map(k => `<span class="sev ${k}">${SEV[k]}: ${count(k)}</span>`).join('') +
    `<span class="sev AZG">AZG: ${count('AZG')}</span>`;
  const rows = law => viol.filter(v => v.law === law).map(v => `<tr><td>${fmtDT(new Date(v.at * 6e4).toISOString())}</td>
    <td>${esc(v.title)}<div class="muted">${esc(v.rule)}${v.note ? ' · ' + esc(v.note) : ''}</div></td>
    <td class="num">${hm(v.value)} h</td><td class="num">${hm(v.limit)} h</td>
    <td>${v.sev ? `<span class="sev ${v.sev}">${SEV[v.sev]}</span>` : ''}</td><td>${esc(v.fine)}</td></tr>`).join('');
  const tbl = (law, head) => {
    const r = rows(law);
    return `<h3>${head}</h3>` + (r ? `<div class="tbl"><table><tr><th>Zeit</th><th>Verstoß</th><th class="num">Wert</th>
      <th class="num">Grenze</th><th>Schwere</th><th>Strafrahmen</th></tr>${r}</table></div>` : '<p class="empty">Keine Verstöße gefunden.</p>');
  };
  return `<p class="msg">Automatische Prüfung nach VO (EG) 561/2006 (Schwere nach Anhang III RL 2006/22/EG, Strafrahmen für den Lenker
    nach KFG §134) und österreichischem AZG. Vereinfacht, keine Rechtsberatung: Ausnahmen (Fähre/Zug, Mehrfahrerbetrieb, Halteplatz,
    12-Tage-Regel, Ausgleich reduzierter Wochenruhe) werden nicht geprüft, Zeit ohne Karte zählt als Ruhe.</p>
    <div class="chips">${chips}</div>
    ${tbl('EU', 'Lenk- und Ruhezeiten (EU, KFG)')}${tbl('AZG', 'Arbeitszeit (AZG, Österreich)')}`;
}

const placeType = t => ['Beginn', 'Ende', 'Beginn (manuell)', 'Ende (manuell)'][t] ?? t;

function renderTab(n, tab) {
  switch (tab) {
    case 'days': return renderDays(n);
    case 'ctrl': return renderCtrl(n.viol);
    case 'veh': return table(['Kennzeichen', 'Von', 'Bis', 'Start km', 'Ende km', 'km', 'FIN'],
      n.veh.map(v => [reg(v.vehicle_registration), fmtDT(v.vehicle_first_use), fmtDT(v.vehicle_last_use), km(v.vehicle_odometer_begin),
        km(v.vehicle_odometer_end), km(v.vehicle_odometer_end - v.vehicle_odometer_begin), v.vehicle_identification_number || '']));
    case 'cards': return table(['Fahrer', 'Karte', 'Slot', 'Gesteckt', 'Entnommen', 'Start km', 'Ende km', 'km'],
      n.cards.map(c => [holder(c.card_holder_name), cardNo(c.full_card_number || c.full_card_number_and_generation),
        c.card_slot_number === 1 ? 'Beifahrer' : 'Fahrer', fmtDT(c.card_insertion_time), fmtDT(c.card_withdrawal_time),
        km(c.vehicle_odometer_value_at_insertion), km(c.vehicle_odometer_value_at_withdrawal),
        c.vehicle_odometer_value_at_withdrawal ? km(c.vehicle_odometer_value_at_withdrawal - c.vehicle_odometer_value_at_insertion) : '']));
    case 'places': return table(n.kind === 'vu' ? ['Zeit', 'Eintrag', 'Land', 'km', 'Karte'] : ['Zeit', 'Eintrag', 'Land', 'km'],
      [...n.places].sort((a, b) => b.entry_time.localeCompare(a.entry_time)).map(p => [fmtDT(p.entry_time), placeType(p.entry_type_daily_work_period),
        nation(p.daily_work_period_country), km(p.vehicle_odometer_value), ...(n.kind === 'vu' ? [p.card] : [])]));
    case 'events': return table(['Beginn', 'Ende', 'Art', n.kind === 'vu' ? 'Karte' : 'Fahrzeug'],
      [...n.events].sort((a, b) => b.begin.localeCompare(a.begin)).map(e => [fmtDT(e.begin), fmtDT(e.end),
        EVENTS[e.type] || `Code 0x${e.type.toString(16)}`, e.info]));
    case 'tech': return table(['Datum', 'Zweck', 'Werkstatt', 'km', 'Reifen', 'w', 'k', 'l (mm)', 'V max', 'Nächste Prüfung'],
      n.calib.map(c => [fmtD(c.new_time_value || c.old_time_value), CALIB[c.calibration_purpose] || c.calibration_purpose, (c.workshop_name || '').trim(),
        km(c.new_odometer_value), (c.tyre_size || '').trim(), c.w_vehicle_characteristic_constant, c.k_constant_of_recording_equipment,
        c.l_tyre_circumference, c.authorised_speed]));
  }
}

async function openFile(id) {
  const f = files.find(x => x.id === id);
  if (!f) return;
  current = f;
  history.replaceState(null, '', '#' + id);
  renderList();
  const view = $('#view');
  view.innerHTML = '<p class="empty">Lade …</p>';
  let res;
  try { res = await api('/api/files/' + id); } catch (e) { view.innerHTML = `<p class="msg err">${esc(e.message)}</p>`; return; }
  const n = res.kind === 'vu' ? normVu(res.data) : normCard(res.data);
  const v = verification(res.data);
  const tabs = n.kind === 'vu'
    ? [['days', 'Tage'], ['cards', 'Karten'], ['places', 'Orte'], ['events', 'Ereignisse/Fehler'], ['tech', 'Technik']]
    : [['days', 'Tage'], ['veh', 'Fahrzeuge'], ['places', 'Orte'], ['events', 'Ereignisse/Fehler'], ['ctrl', 'Kontrolle']];
  if (n.kind === 'card') n.viol = analyze(n.days);
  view.innerHTML = `<div class="head"><div><h2>${esc(n.title)}</h2><div class="muted">${esc(n.sub)} · ${esc(f.name)}</div></div>
    <div><span class="badge ${v.ok === v.total && v.total ? 'ok' : 'bad'}" title="digitale Signaturen der Datenblöcke">
      Signatur ${v.ok === v.total && v.total ? 'gültig' : `${v.ok}/${v.total} gültig`}</span>
      <a href="/api/files/${id}?raw" class="muted">Original</a>
      <button class="danger" id="del">Löschen</button></div></div>
    <div class="facts">${n.facts.filter(x => String(x[1]).trim()).map(([k, val]) => `<div><span>${k}</span>${esc(val)}</div>`).join('')}</div>
    <div class="tabs">${tabs.map(([k, l], i) => `<button data-tab="${k}" class="${i ? '' : 'on'}">${l}</button>`).join('')}</div>
    <div id="tab"></div>`;
  const show = tab => {
    view.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    $('#tab').innerHTML = renderTab(n, tab);
  };
  view.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => show(b.dataset.tab));
  $('#tab').onclick = e => {
    const el = e.target.closest('.day');
    if (!el || e.target.closest('.detail')) return;
    const det = el.querySelector('.detail');
    det.hidden = !det.hidden;
    if (!det.hidden) det.innerHTML = dayDetail(n.zdays[el.dataset.i]);
  };
  $('#del').onclick = async e => {
    if (e.target.dataset.armed !== '1') { e.target.dataset.armed = '1'; e.target.textContent = 'Wirklich löschen?'; return; }
    await api('/api/files/' + id, { method: 'DELETE' });
    current = null;
    history.replaceState(null, '', location.pathname);
    view.innerHTML = '<p class="empty">Datei gelöscht.</p>';
    loadList();
  };
  show('days');
}

async function uploadFiles(list) {
  if (!list.length) return;
  const fd = new FormData();
  [...list].forEach(f => fd.append('files', f));
  const msg = $('#msg');
  msg.hidden = false; msg.className = 'msg'; msg.textContent = 'Lade hoch …';
  try {
    const res = await api('/api/files', { method: 'POST', body: fd });
    const bad = res.filter(r => r.error);
    msg.className = 'msg' + (bad.length ? ' err' : '');
    msg.textContent = `${res.length - bad.length} Datei(en) gespeichert.` + bad.map(r => `\n${r.name}: ${r.error}`).join('');
    await loadList();
    const first = res.find(r => r.file);
    if (first) openFile(first.file.id);
  } catch (e) { msg.className = 'msg err'; msg.textContent = e.message; }
}

$('#readcard').onclick = async e => {
  const btn = e.target, msg = $('#msg');
  btn.disabled = true;
  msg.hidden = false; msg.className = 'msg'; msg.textContent = 'Lese Karte aus … (Karte nicht entnehmen)';
  try {
    const f = await api('/api/card/read', { method: 'POST' });
    msg.textContent = `Karte ausgelesen: ${f.name}`;
    await loadList();
    openFile(f.id);
  } catch (err) { msg.className = 'msg err'; msg.textContent = err.message; }
  btn.disabled = false;
};
$('#files').onclick = e => { const li = e.target.closest('li[data-id]'); if (li) openFile(li.dataset.id); };
$('#pick').onchange = e => { uploadFiles(e.target.files); e.target.value = ''; };
const drop = $('#drop');
['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => uploadFiles(e.dataTransfer.files));
document.querySelectorAll('.filter button').forEach(b => b.onclick = () => {
  filter = b.dataset.kind;
  document.querySelectorAll('.filter button').forEach(x => x.classList.toggle('on', x === b));
  renderList();
});
function showTz() {
  document.querySelectorAll('[data-tz]').forEach(b => b.classList.toggle('on', b.dataset.tz === tzMode));
  $('#tzhint').textContent = tzMode === 'local' ? `Zeiten in Ortszeit (${LOCAL_TZ})` : 'Zeiten in UTC (wie im Tachografen gespeichert)';
}
document.querySelectorAll('[data-tz]').forEach(b => b.onclick = () => {
  tzMode = b.dataset.tz;
  try { localStorage.setItem('tz', tzMode); } catch { }
  showTz();
  renderList();
  if (current) openFile(current.id);
});
showTz();
loadList().then(() => { if (location.hash) openFile(location.hash.slice(1)); });
