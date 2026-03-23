// ════════════════════════════════════════════════════════════════
//  KÖRÖM STÚDIÓ — Google Apps Script háttérrendszer
//  Google Sheets adatbázis + Google Calendar integráció
//
//  TELEPÍTÉS (egyszer kell elvégezni):
//  1. Nyisd meg: script.google.com
//  2. Új projekt → másold be ezt az egész kódot
//  3. Mentés (Ctrl+S)
//  4. Bal oldalt: "Szolgáltatások" (+) → keresd: "Google Calendar API" → add hozzá
//  5. Telepítés → Webalkalmazásként telepíteni
//       Futtassa: Én
//       Hozzáférés: Mindenki
//  6. Engedélyezés → Google fiókod elfogadja
//  7. Kapott URL → másold be az index.html SCRIPT_URL sorába
//
//  FONTOS: Ha módosítod a kódot, mindig újra kell telepíteni
//  (Telepítés → Új verzió kezelése → Telepítés)
// ════════════════════════════════════════════════════════════════

// ── KONFIGURÁCIÓ ─────────────────────────────────────────────────
// A naptár ID-ja: alapból a Google fiókoddal azonos email cím.
// Ha más naptárat szeretnél, a Google Naptárban:
// Naptár beállításai → "Naptár integrálása" → Naptár azonosítója
const CALENDAR_ID   = 'primary'; // 'primary' = az alapértelmezett naptárad

// Időzóna — Magyarország
const TIMEZONE      = 'Europe/Budapest';

// Sheet nevek
const SHEET_APPTS   = 'Foglalások';
const SHEET_WH      = 'Munkaidők';

// Naptár esemény színe (1-11, Google Calendar színkódok)
// 1=kék, 2=zöld, 3=lila, 4=piros, 5=sárga, 6=narancs, 7=türkiz, 11=piros-pink
const EVENT_COLOR   = 11;
// ─────────────────────────────────────────────────────────────────

// ── SHEET INICIALIZÁLÁS ───────────────────────────────────────────
function getApptSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh   = ss.getSheetByName(SHEET_APPTS);
  if (!sh) {
    sh = ss.insertSheet(SHEET_APPTS);
    sh.appendRow([
      'ID', 'Dátum', 'Időpont', 'Időtartam (perc)',
      'Szolgáltatás ID', 'Szolgáltatás neve',
      'Név', 'Email', 'Telefon', 'Státusz',
      'Naptár esemény ID', 'Létrehozva'
    ]);
    sh.setFrozenRows(1);
    const hdr = sh.getRange(1, 1, 1, 12);
    hdr.setBackground('#1a0d11');
    hdr.setFontColor('#e891aa');
    hdr.setFontWeight('bold');
    [80,90,70,110,120,180,140,200,130,90,200,140].forEach((w,i) => sh.setColumnWidth(i+1, w));
  }
  return sh;
}

function getWhSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh   = ss.getSheetByName(SHEET_WH);
  if (!sh) {
    sh = ss.insertSheet(SHEET_WH);
    sh.appendRow(['Dátum', 'Kezdés', 'Vége', 'Zárva']);
    sh.setFrozenRows(1);
    const hdr = sh.getRange(1, 1, 1, 4);
    hdr.setBackground('#1a0d11');
    hdr.setFontColor('#e891aa');
    hdr.setFontWeight('bold');
  }
  return sh;
}

// ── GET: minden adat lekérése ─────────────────────────────────────
function doGet(e) {
  const apptSh = getApptSheet();
  const whSh   = getWhSheet();

  // Foglalások beolvasása
  const apptData     = apptSh.getDataRange().getValues();
  const appointments = [];
  for (let i = 1; i < apptData.length; i++) {
    const r = apptData[i];
    if (!r[0]) continue; // üres sor kihagyása
    appointments.push({
      id:          String(r[0]),
      date:        String(r[1]),
      time:        String(r[2]),
      duration:    Number(r[3]) || 90,
      serviceId:   String(r[4] || ''),
      serviceName: String(r[5] || ''),
      name:        String(r[6] || ''),
      email:       String(r[7] || ''),
      phone:       String(r[8] || ''),
      status:      String(r[9] || 'confirmed'),
    });
  }

  // Munkaidők beolvasása
  const whData     = whSh.getDataRange().getValues();
  const workingHours = {};
  for (let i = 1; i < whData.length; i++) {
    const r = whData[i];
    if (!r[0]) continue;
    workingHours[String(r[0])] = {
      start:  String(r[1] || '8:00'),
      end:    String(r[2] || '18:00'),
      closed: r[3] === true || String(r[3]).toUpperCase() === 'TRUE',
    };
  }

  return jsonOut({ success: true, appointments, workingHours });
}

// ── POST: műveletek ───────────────────────────────────────────────
function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch(err) {
    return jsonOut({ success: false, error: 'JSON parse hiba: ' + err.message });
  }

  if (body.action === 'add')       return addAppointment(body);
  if (body.action === 'cancel')    return cancelAppointment(body);
  if (body.action === 'saveHours') return saveHours(body);

  return jsonOut({ success: false, error: 'Ismeretlen action: ' + body.action });
}

// ── ÚJ FOGLALÁS ───────────────────────────────────────────────────
function addAppointment(b) {
  const sh      = getApptSheet();
  const data    = sh.getDataRange().getValues();
  const dur     = parseInt(b.duration) || 90;
  const newStart = timeToMins(b.time);
  const newEnd   = newStart + dur;

  // Ütközés ellenőrzés: átfedő aktív foglalások tiltása
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    if (!r[0]) continue;
    if (String(r[1]) !== String(b.date)) continue;
    if (String(r[9]) === 'cancelled') continue;
    const exStart = timeToMins(String(r[2]));
    const exEnd   = exStart + (parseInt(r[3]) || 90);
    // Ha az új foglalás átfed egy meglévővel
    if (newStart < exEnd && newEnd > exStart) {
      return jsonOut({ success: false, error: 'Ez az időpont már foglalt! Kérjük válassz másikat.' });
    }
  }

  // Google Calendar esemény létrehozása
  const calEventId = createCalendarEvent(b, dur);

  // Mentés Sheetsbe
  const id = Utilities.getUuid();
  sh.appendRow([
    id,
    b.date,
    b.time,
    dur,
    b.serviceId   || '',
    b.serviceName || '',
    b.name,
    b.email,
    b.phone       || '',
    'confirmed',
    calEventId    || '',
    new Date().toISOString()
  ]);

  return jsonOut({ success: true, id });
}

// ── LEMONDÁS ──────────────────────────────────────────────────────
function cancelAppointment(b) {
  const sh   = getApptSheet();
  const data = sh.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    if (String(r[0]) !== String(b.id)) continue;

    // Státusz "cancelled"-re állítása
    sh.getRange(i + 1, 10).setValue('cancelled');

    // Google Calendar esemény törlése (ha van)
    const calEventId = String(r[10] || '');
    if (calEventId) {
      deleteCalendarEvent(calEventId);
    }

    return jsonOut({ success: true });
  }

  return jsonOut({ success: false, error: 'Foglalás nem található (ID: ' + b.id + ')' });
}

// ── MUNKAIDŐK MENTÉSE ─────────────────────────────────────────────
function saveHours(b) {
  const sh   = getWhSheet();
  const data = sh.getDataRange().getValues();
  const wh   = b.workingHours || {};

  Object.entries(wh).forEach(([date, cfg]) => {
    let found = false;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(date)) {
        sh.getRange(i + 1, 1, 1, 4).setValues([[date, cfg.start, cfg.end, cfg.closed]]);
        found = true;
        break;
      }
    }
    if (!found) {
      sh.appendRow([date, cfg.start, cfg.end, cfg.closed]);
    }
  });

  return jsonOut({ success: true });
}

// ── GOOGLE CALENDAR: esemény létrehozása ──────────────────────────
function createCalendarEvent(b, dur) {
  try {
    const calendar = CalendarApp.getCalendarById(CALENDAR_ID);
    if (!calendar) {
      Logger.log('Naptár nem található: ' + CALENDAR_ID);
      return null;
    }

    // Kezdő és záró időpont összeállítása
    // b.date formátuma: 'YYYY-MM-DD', b.time: 'HH:MM'
    const [year, month, day]   = b.date.split('-').map(Number);
    const [startH, startM]     = b.time.split(':').map(Number);
    const startDate = new Date(year, month - 1, day, startH, startM, 0);
    const endDate   = new Date(startDate.getTime() + dur * 60 * 1000);

    // Esemény leírása
    const description = [
      '💅 Köröm Stúdió — Online foglalás',
      '',
      '📋 Szolgáltatás: ' + (b.serviceName || '—'),
      '⏱ Időtartam: ' + formatDurText(dur),
      '',
      '👤 Vendég neve: ' + b.name,
      '📧 Email: ' + b.email,
      (b.phone ? '📞 Telefon: ' + b.phone : ''),
      '',
      '🕐 Foglalás időpontja: ' + new Date().toLocaleString('hu-HU', {timeZone: TIMEZONE}),
    ].filter(Boolean).join('\n');

    // Esemény létrehozása
    const event = calendar.createEvent(
      '💅 ' + b.name + ' — ' + (b.serviceName || 'Foglalás'),
      startDate,
      endDate,
      {
        description: description,
        // Ha van email, meghívót is küld a vendégnek
        guests: b.email || '',
        sendInvites: false, // true = vendég kap emailt a naptárból is; false = csak te látod
      }
    );

    // Esemény színének beállítása
    try {
      event.setColor(String(EVENT_COLOR));
    } catch(colorErr) {
      Logger.log('Szín beállítási hiba (nem kritikus): ' + colorErr);
    }

    Logger.log('Naptár esemény létrehozva: ' + event.getId());
    return event.getId();

  } catch(err) {
    // Ha a naptár nem elérhető, a foglalás akkor is megtörténik
    Logger.log('Naptár hiba (nem kritikus): ' + err.message);
    return null;
  }
}

// ── GOOGLE CALENDAR: esemény törlése ─────────────────────────────
function deleteCalendarEvent(eventId) {
  try {
    const calendar = CalendarApp.getCalendarById(CALENDAR_ID);
    if (!calendar) return;

    const event = calendar.getEventById(eventId);
    if (event) {
      event.deleteEvent();
      Logger.log('Naptár esemény törölve: ' + eventId);
    }
  } catch(err) {
    Logger.log('Naptár törlési hiba (nem kritikus): ' + err.message);
  }
}

// ── SEGÉDFÜGGVÉNYEK ───────────────────────────────────────────────
function timeToMins(t) {
  const parts = String(t).split(':').map(Number);
  return (parts[0] || 0) * 60 + (parts[1] || 0);
}

function formatDurText(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (m === 0) return h + ' óra';
  if (h === 0) return m + ' perc';
  return h + ',5 óra';
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── TESZT FUNKCIÓ (opcionális, futtatható a Scriptből) ────────────
// Ha szeretnéd tesztelni a naptár kapcsolatot, futtasd ezt manuálisan:
function testCalendar() {
  const cal = CalendarApp.getCalendarById(CALENDAR_ID);
  if (cal) {
    Logger.log('✅ Naptár kapcsolat OK: ' + cal.getName());
  } else {
    Logger.log('❌ Naptár nem található! Ellenőrizd a CALENDAR_ID értékét.');
  }
}
