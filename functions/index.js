/**
 * Firebase Cloud Functions — Xodimlar Monitoring Telegram Bot
 * Ma'lumot: checkins (selfie) + attendance (status) dan olinadi
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

admin.initializeApp();
const db = admin.database();

// Bot token Firebase DB'dan olinadi — kodda saqlanmaydi
let _botToken = null;
async function getBotToken() {
  if (_botToken) return _botToken;
  const snap = await db.ref("config/bot_token").once("value");
  _botToken = snap.val();
  return _botToken;
}

// Fallback hardcoded list \u2014 used only if /employees DB lookup fails or is empty.
const EMPLOYEES_FALLBACK = [
  "Umrzoqov Bunyod","Ermamatov Xurshid",
  "Akbarova Moxlaroyim","Faxriddinov Oxunjon",
  "Hamdamov Shuxrat","Nazarov Muzaffar","Nurmamatov Oxunjon",
  "Xolmurodov Dostonjon","Qurbonov Shavkat","Narzullayev Rustam",
  "Islomov G\u2018ulomjon","Ibrohimov Shuhrat","Barnoqulov Shahzod",
  "Axadov Izzatullo","Jo\u2018raqulov Jahongirbek","Jaynakov Temur",
  "Saidov Lazizbek","Pirbayev Berdiyor","Husainova Klara",
  "Ne\u2018matov Shahzodbek","Muhammadov Jaloliddin"
];

// Live employee list \u2014 wrapper over getEmployeeProfiles cache (no extra DB call)
async function getEmployees() {
  const profiles = await getEmployeeProfiles();
  const list = Object.keys(profiles);
  return list.length > 0 ? list : EMPLOYEES_FALLBACK;
}

// Backward-compatible alias \u2014 used by reports that haven't been migrated to async getEmployees yet.
// FALLBACK list only. Async getEmployees() call returns the LIVE DB list.
const EMPLOYEES = EMPLOYEES_FALLBACK;

// Fallback birthdays \u2014 used only if /employees DB lookup fails
const BIRTHDAYS_FALLBACK = {
  "Umrzoqov Bunyod":"23.07.1988","Ermamatov Xurshid":"29.03.1986",
  "Akbarova Moxlaroyim":"11.04.1998","Faxriddinov Oxunjon":"29.04.1992",
  "Hamdamov Shuxrat":"05.03.1989","Nazarov Muzaffar":"22.02.1984",
  "Nurmamatov Oxunjon":"22.12.1992","Xolmurodov Dostonjon":"22.07.1997",
  "Qurbonov Shavkat":"23.11.1987","Narzullayev Rustam":"12.09.1996",
  "Islomov G\u2018ulomjon":"02.03.1986","Ibrohimov Shuhrat":"25.04.1982",
  "Barnoqulov Shahzod":"11.10.2001","Axadov Izzatullo":"05.07.1993",
  "Jo\u2018raqulov Jahongirbek":"04.03.2001","Jaynakov Temur":"21.08.1988",
  "Saidov Lazizbek":"31.10.2002","Pirbayev Berdiyor":"23.12.1989",
  "Husainova Klara":"30.11.1987","Ne\u2018matov Shahzodbek":"22.07.1999",
  "Muhammadov Jaloliddin":"22.01.1994"
};

// Live birthdays + employee profile data \u2014 fetched from /employees on first call.
// Returns map { "Ism Familiya": { birthDate, position, phone, fullName } }
let _profilesCache = null;
let _profilesCacheTs = 0;
async function getEmployeeProfiles() {
  const now = Date.now();
  if (_profilesCache && (now - _profilesCacheTs) < 30000) return _profilesCache;
  try {
    const snap = await db.ref("/employees").once("value");
    const v = snap.val();
    if (v && Object.keys(v).length > 0) {
      const map = {};
      Object.values(v).forEach(emp => {
        if (!emp) return;
        const name = emp.fullName ? emp.fullName.split(" ").slice(0, 2).join(" ")
                   : (emp.lastName && emp.firstName ? `${emp.lastName} ${emp.firstName}` : null);
        if (name) {
          map[name] = {
            birthDate: emp.birthDate || BIRTHDAYS_FALLBACK[name] || null,
            position: emp.position || "",
            phone: emp.phone || "",
            fullName: emp.fullName || name,
            department: emp.department || ""
          };
        }
      });
      _profilesCache = map;
      _profilesCacheTs = now;
      return map;
    }
  } catch (e) { console.warn("getEmployeeProfiles error:", e.message); }
  // Fallback \u2014 convert hardcoded BIRTHDAYS to profile shape
  const fallback = {};
  Object.entries(BIRTHDAYS_FALLBACK).forEach(([name, bd]) => { fallback[name] = { birthDate: bd, position: "", phone: "", fullName: name, department: "" }; });
  _profilesCache = fallback;
  _profilesCacheTs = now;
  return fallback;
}

// Backward-compatible \u2014 kept for legacy code paths that haven't migrated yet
const BIRTHDAYS = BIRTHDAYS_FALLBACK;

const DAYS_UZ = ["Yakshanba","Dushanba","Seshanba","Chorshanba","Payshanba","Juma","Shanba"];
const STATUS_LABELS = {
  sick: "bemor", trip: "xizmat safari", training: "malaka oshirish",
  vacation: "ta\u2018til", excused: "sababli"
};
const STATUS_ICONS = {
  sick: "🏥", trip: "✈️", training: "📚", vacation: "🏖", excused: "📋"
};
const NON_WORKING = ["sick", "trip", "training", "vacation", "excused"];

function safeKey(name) {
  return (name || "").replace(/[‘’ʼ`'`]/g, "").replace(/\s+/g, "_").replace(/[.#$/[\]]/g, "_");
}

function fmtDate(d) {
  // Always format in Asia/Tashkent (UTC+5) regardless of server timezone.
  // Cloud Functions run in UTC by default — without this conversion, /davomat
  // at midnight UZB (19:00 UTC prev day) returns yesterday's data.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tashkent',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return fmt.format(d); // e.g. "2026-04-30"
}

function fmtMins(m) {
  if (!m) return "—";
  if (m < 60) return `${m} daqiqa`;
  return `${Math.floor(m/60)} soat ${m%60} daqiqa`;
}

async function getChatId() {
  const snap = await db.ref("telegram_config/chatId").once("value");
  return snap.val();
}

async function sendMessage(chatId, text) {
  const token = await getBotToken();
  if (!token) { console.error("Bot token not configured"); return; }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  return fetch(url, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true })
  }).then(r => r.json());
}

// ─── DAVOMAT HISOBOT ─────────────────────
// Selfie (checkins) + attendance (status) dan ma'lumot oladi
async function buildDavomatReport(dateKey) {
  const [attSnap, checkSnap, employees] = await Promise.all([
    db.ref(`attendance/${dateKey}`).once("value"),
    db.ref(`checkins/${dateKey}`).once("value"),
    getEmployees()  // LIVE list — picks up new employees within 30s
  ]);
  const attData = attSnap.val() || {};
  const checkins = checkSnap.val() || {};

  const d = dateKey.split("-");
  const dateObj = new Date(parseInt(d[0]), parseInt(d[1])-1, parseInt(d[2]));
  const dayName = DAYS_UZ[dateObj.getDay()];
  const dateDisp = `${d[2]}.${d[1]}.${d[0]}`;

  const kelganlar = [];   // selfie qilgan = kelgan
  const sababli = [];     // sick/trip/vacation/excused/training
  const kelmagan = [];    // selfie qilmagan va statusi yo'q

  employees.forEach(emp => {
    const key = safeKey(emp);
    const att = attData[key];
    const check = checkins[key];
    const status = att?.status;

    // 1. Agar sababli status bo'lsa
    if (status && NON_WORKING.includes(status)) {
      sababli.push({ name: emp, status, label: STATUS_LABELS[status], icon: STATUS_ICONS[status] });
      return;
    }

    // 2. Agar selfie qilgan bo'lsa = kelgan
    if (check && (check.morning || check.afternoon)) {
      const lateMin = (att?.morning || 0) + (att?.afternoon || 0);
      kelganlar.push({ name: emp, lateMin, status: status || "present" });
      return;
    }

    // 3. Agar attendance da present/late bo'lsa (selfiesiz ham)
    if (status === "present" || status === "late") {
      const lateMin = (att?.morning || 0) + (att?.afternoon || 0);
      kelganlar.push({ name: emp, lateMin, status });
      return;
    }

    // 4. Agar absent deb belgilangan bo'lsa
    if (status === "absent") {
      kelmagan.push(emp);
      return;
    }

    // 5. Qolganlari — selfie qilmagan / kelmagan
    kelmagan.push(emp);
  });

  const workingTotal = employees.length - sababli.length;
  const pct = workingTotal > 0 ? Math.round(kelganlar.length / workingTotal * 100) : 0;

  let text = `📋 <b>DAVOMAT HISOBOTI</b>\n`;
  text += `📅 ${dateDisp} | ${dayName}\n`;
  text += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

  // Kelganlar
  text += `✅ <b>Kelganlar (${kelganlar.length}):</b>\n`;
  kelganlar.forEach((e, i) => {
    let line = `  ${i+1}. ${e.name}`;
    if (e.lateMin > 0) line += ` ⏰ (${fmtMins(e.lateMin)} kechikdi)`;
    text += line + "\n";
  });

  // Sababli
  if (sababli.length > 0) {
    text += `\n📋 <b>Sababli (${sababli.length}):</b>\n`;
    sababli.forEach((e, i) => {
      text += `  ${i+1}. ${e.name} (${e.icon} ${e.label})\n`;
    });
  }

  // Kelmagan
  if (kelmagan.length > 0) {
    text += `\n❌ <b>Kelmagan / Selfie qilmagan (${kelmagan.length}):</b>\n`;
    kelmagan.forEach((e, i) => {
      text += `  ${i+1}. ${e}\n`;
    });
  }

  text += `\n━━━━━━━━━━━━━━━━━━━━━\n`;
  text += `📊 Davomat: ${kelganlar.length}/${workingTotal} (${pct}%)`;

  return text;
}

// ─── KECHIKKANLAR HISOBOT ─────────────────────
async function buildKechikkanlarReport(dateKey) {
  const [snap, employees] = await Promise.all([
    db.ref(`attendance/${dateKey}`).once("value"),
    getEmployees()
  ]);
  const dayData = snap.val() || {};

  const lateList = [];
  employees.forEach(emp => {
    const rec = dayData[safeKey(emp)];
    if (!rec) return;
    const morning = rec.morning || 0;
    const afternoon = rec.afternoon || 0;
    const total = morning + afternoon;
    if (rec.status === "late" || total > 0) {
      lateList.push({name: emp, morning, afternoon, total});
    }
  });

  if (lateList.length === 0) return "✅ Bugun kechikkan xodim yo'q!";

  lateList.sort((a, b) => b.total - a.total);
  const d = dateKey.split("-");
  let text = `⏰ <b>Kechikkanlar — ${d[2]}.${d[1]}.${d[0]}</b>\n━━━━━━━━━━━━━━━━━━\n`;
  lateList.forEach((item, i) => {
    text += `${i+1}. <b>${item.name}</b> — ${fmtMins(item.total)}`;
    if (item.morning > 0 && item.afternoon > 0) {
      text += ` (ert: ${item.morning}d, tush: ${item.afternoon}d)`;
    }
    text += "\n";
  });
  text += `\nJami: <b>${lateList.length}</b> xodim kechikdi`;
  return text;
}

// ─── OYLIK STATISTIKA ─────────────────────
async function buildStatistikaReport() {
  const now = new Date();
  const yr = now.getFullYear();
  const mon = now.getMonth();
  const today = fmtDate(now);
  const dates = [];
  const d = new Date(yr, mon, 1);
  while (d.getMonth() === mon && fmtDate(d) <= today) {
    if (d.getDay() >= 1 && d.getDay() <= 5) dates.push(fmtDate(new Date(d)));
    d.setDate(d.getDate() + 1);
  }
  if (dates.length === 0) return "📈 Bu oyda hali ish kuni yo'q.";

  const [attSnap, checkSnap, employees] = await Promise.all([
    db.ref("attendance").once("value"),
    db.ref("checkins").once("value"),
    getEmployees()
  ]);
  const allAtt = attSnap.val() || {};
  const allCheckins = checkSnap.val() || {};

  let totalPresent = 0, totalLate = 0, totalAbsent = 0, totalLateMins = 0;
  const empScores = [];

  employees.forEach(emp => {
    let present = 0, late = 0, absent = 0, lateMins = 0, workDays = 0;
    dates.forEach(dk => {
      const key = safeKey(emp);
      const att = allAtt[dk]?.[key];
      const check = allCheckins[dk]?.[key];
      const status = att?.status;

      if (status && NON_WORKING.includes(status)) return; // sababli — hisobga olinmaydi
      workDays++;

      const hasSelfie = check && (check.morning || check.afternoon);
      if (hasSelfie || status === "present" || status === "late") {
        present++;
        if (status === "late" || (att?.morning || 0) + (att?.afternoon || 0) > 0) late++;
        lateMins += (att?.morning || 0) + (att?.afternoon || 0);
      } else {
        absent++;
      }
    });
    totalPresent += present;
    totalLate += late;
    totalAbsent += absent;
    totalLateMins += lateMins;
    const score = Math.max(0, 100 - Math.round(lateMins / Math.max(1, workDays * 480) * 100 * 8) - absent * 5 - late * 2);
    empScores.push({name: emp, score, present, late, absent, lateMins});
  });

  empScores.sort((a, b) => b.score - a.score);
  const avgScore = Math.round(empScores.reduce((s, e) => s + e.score, 0) / Math.max(1, employees.length));
  const months = ["Yanvar","Fevral","Mart","Aprel","May","Iyun","Iyul","Avgust","Sentabr","Oktabr","Noyabr","Dekabr"];

  let text = `📈 <b>Oylik statistika — ${months[mon]} ${yr}</b>\n`;
  text += `━━━━━━━━━━━━━━━━━━\n`;
  text += `📅 O'tgan ish kunlari: <b>${dates.length}</b>\n`;
  text += `👥 Xodimlar: <b>${employees.length}</b>\n`;
  text += `✅ Jami kelgan: <b>${totalPresent}</b>\n`;
  text += `⏰ Kechikishlar: <b>${totalLate}</b>\n`;
  text += `❌ Kelmagan: <b>${totalAbsent}</b>\n`;
  text += `🕐 Jami kechikish: <b>${fmtMins(totalLateMins)}</b>\n`;
  text += `🎯 Intizom: <b>${avgScore}/100</b>\n`;
  text += `━━━━━━━━━━━━━━━━━━\n\n`;
  text += `🏆 <b>Top 5:</b>\n`;
  ["🥇","🥈","🥉","4️⃣","5️⃣"].forEach((m, i) => {
    if (empScores[i]) text += `${m} ${empScores[i].name} — <b>${empScores[i].score}</b>\n`;
  });

  const worst = empScores.filter(e => e.score < 100);
  if (worst.length > 0) {
    text += `\n⚠️ <b>Eng past:</b>\n`;
    worst.slice(-3).reverse().forEach(e => {
      text += `  ${e.name} — <b>${e.score}</b>\n`;
    });
  }
  return text;
}

// ═══ BOT HELP TEXT ═══
function botHelpText() {
  return "🤖 <b>Xodimlar Monitoring Bot</b>\n\n"
    + "<b>Davomat:</b>\n"
    + "📊 /davomat — Bugungi davomat\n"
    + "⏰ /kechikkanlar — Kechikkan xodimlar\n"
    + "🌴 /tatil — Hozirgi ta'til/safar/bemorlar\n"
    + "📈 /statistika — Oylik statistika\n\n"
    + "<b>Xodimlar:</b>\n"
    + "👥 /xodimlar — Barcha xodimlar ro'yxati\n"
    + "🔍 /qidir <i>ism</i> — Xodim bo'yicha qidirish\n"
    + "🎂 /tugilgan — Tug'ilgan kunlar (yaqin 30 kun)\n\n"
    + "<b>Shaxsiy (DM'da):</b>\n"
    + "👤 /menpda — Mening bugungi davomatim\n"
    + "📊 /menstat — Mening oylik statistikam\n"
    + "ℹ️ /menda — Mening profilim\n\n"
    + "<b>Boshqa:</b>\n"
    + "❓ /yordam — Bu yordam xabari\n"
    + "🌐 Sayt: <a href=\"https://intizominvest.vercel.app\">intizominvest.vercel.app</a>\n"
    + "📦 GitHub: <a href=\"https://github.com/lazizbeksaidov/davomat-tizimi\">davomat-tizimi</a>\n\n"
    + "📍 Navoiy viloyati Investitsiyalar,\nsanoat va savdo boshqarmasi";
}

// ═══ XODIMLAR RO'YXATI ═══
async function buildEmployeeListReport() {
  const profiles = await getEmployeeProfiles();
  const list = Object.entries(profiles).sort(([a],[b]) => a.localeCompare(b));
  if (list.length === 0) return "👥 Xodimlar ro'yxati bo'sh.";
  let text = `👥 <b>Xodimlar ro'yxati (${list.length} nafar)</b>\n━━━━━━━━━━━━━━━━━━\n\n`;
  list.forEach(([name, p], i) => {
    text += `${i+1}. <b>${name}</b>\n`;
    if (p.position) text += `   💼 ${p.position}\n`;
    if (p.phone) text += `   📞 ${p.phone}\n`;
    if (i < list.length - 1) text += "\n";
  });
  return text;
}

// ═══ XODIM QIDIRISH ═══
// /qidir Saidov → faqat Saidov(lar)ning bugungi davomati
async function buildEmployeeSearchReport(query, todayKey) {
  const profiles = await getEmployeeProfiles();
  const q = query.toLowerCase().trim();
  const matches = Object.keys(profiles).filter(name => name.toLowerCase().includes(q));
  if (matches.length === 0) return `🔍 "${query}" bo'yicha xodim topilmadi.`;
  const [attSnap, checkSnap] = await Promise.all([
    db.ref(`attendance/${todayKey}`).once("value"),
    db.ref(`checkins/${todayKey}`).once("value")
  ]);
  const att = attSnap.val() || {};
  const ck = checkSnap.val() || {};
  const d = todayKey.split("-");
  let text = `🔍 <b>"${query}" — ${matches.length} ta natija</b>\n📅 ${d[2]}.${d[1]}.${d[0]}\n━━━━━━━━━━━━━━━━━━\n\n`;
  matches.forEach((name, i) => {
    const key = safeKey(name);
    const a = att[key] || {};
    const c = ck[key];
    const p = profiles[name];
    text += `${i+1}. <b>${name}</b>\n`;
    if (p.position) text += `   💼 ${p.position}\n`;
    // Status
    let statusIcon = "❓", statusText = "Ma'lumot yo'q";
    if (a.status && NON_WORKING.includes(a.status)) {
      statusIcon = STATUS_ICONS[a.status] || "📋";
      statusText = STATUS_LABELS[a.status] || a.status;
    } else if (c && c.morning) {
      const lateMin = (a.morning || 0) + (a.afternoon || 0);
      statusIcon = lateMin > 0 ? "⏰" : "✅";
      statusText = lateMin > 0 ? `Kechikdi (${lateMin} d)` : "Ish joyida";
      if (c.morning && c.morning.time) text += `   🌅 Ertalab: ${c.morning.time}\n`;
      if (c.afternoon && c.afternoon.time) text += `   🌆 Tushlik: ${c.afternoon.time}\n`;
    } else {
      statusIcon = "❌";
      statusText = "Selfie yo'q";
    }
    text += `   ${statusIcon} ${statusText}\n`;
    if (i < matches.length - 1) text += "\n";
  });
  return text;
}

// ═══ TUG'ILGAN KUNLAR (yaqin 30 kun) ═══
async function buildBirthdaysReport() {
  const profiles = await getEmployeeProfiles();
  const today = new Date(fmtDate(new Date()) + "T12:00:00");
  const items = [];
  Object.entries(profiles).forEach(([name, p]) => {
    if (!p.birthDate) return;
    const parts = p.birthDate.split(".");
    if (parts.length !== 3) return;
    const day = parseInt(parts[0]), mon = parseInt(parts[1]) - 1, yr = parseInt(parts[2]);
    if (isNaN(day) || isNaN(mon)) return;
    // Next birthday
    let next = new Date(today.getFullYear(), mon, day);
    if (next < today) next = new Date(today.getFullYear() + 1, mon, day);
    const daysLeft = Math.round((next - today) / 86400000);
    if (daysLeft > 30) return;
    // Age person will TURN at next birthday (not their current age) — this is what we display
    const ageAtNext = next.getFullYear() - yr;
    items.push({ name, daysLeft, date: `${String(day).padStart(2,"0")}.${String(mon+1).padStart(2,"0")}`, age: ageAtNext });
  });
  items.sort((a, b) => a.daysLeft - b.daysLeft);
  if (items.length === 0) return "🎂 Yaqin 30 kunda tug'ilgan kun yo'q.";
  let text = `🎂 <b>Yaqin tug'ilgan kunlar</b>\n━━━━━━━━━━━━━━━━━━\n\n`;
  items.forEach((it, i) => {
    const tag = it.daysLeft === 0 ? " 🎉 BUGUN!" : it.daysLeft === 1 ? " ⏰ Ertaga!" : ` (${it.daysLeft} kun)`;
    text += `${i+1}. <b>${it.name}</b> — ${it.date} · ${it.age} yosh${tag}\n`;
  });
  return text;
}

// ═══ SHAXSIY DAVOMAT (DM'da xodim o'zining bugungi ma'lumotini) ═══
async function buildPersonalAttendanceReport(chatId, todayKey) {
  // chatId → linked phone → match employee by name in profiles
  const phoneSnap = await db.ref(`tg_sessions/${chatId}/linkedPhone`).once("value");
  const phone = phoneSnap.val();
  if (!phone) return "❌ Tizimga kirmagansiz. /login bosing.";
  const rec = await lookupWhitelist(phone);
  if (!rec || !rec.name) return "❌ Profil topilmadi.";
  const empName = rec.name;
  const key = safeKey(empName);
  const [attSnap, checkSnap] = await Promise.all([
    db.ref(`attendance/${todayKey}/${key}`).once("value"),
    db.ref(`checkins/${todayKey}/${key}`).once("value")
  ]);
  const a = attSnap.val() || {};
  const c = checkSnap.val();
  const d = todayKey.split("-");
  let text = `👤 <b>${empName}</b>\n📅 Bugun: ${d[2]}.${d[1]}.${d[0]}\n━━━━━━━━━━━━━━━━━━\n\n`;
  if (a.status && NON_WORKING.includes(a.status)) {
    text += `${STATUS_ICONS[a.status]} <b>Holat:</b> ${STATUS_LABELS[a.status]}\n`;
    if (a.note) text += `📝 Izoh: ${a.note}\n`;
    return text;
  }
  if (c && c.morning) {
    text += `🌅 <b>Ertalabki selfie:</b> ${c.morning.time}\n`;
    if (c.morning.lateMinutes > 0) text += `   ⏰ Kechikish: ${c.morning.lateMinutes} daqiqa\n`;
    if (c.morning.gpsDistance != null) text += `   📍 GPS: ${c.morning.gpsDistance}m ${c.morning.gpsOk ? "✓" : "⚠"}\n`;
  } else {
    text += `🌅 Ertalabki selfie: ❌ qilinmagan\n`;
  }
  if (c && c.afternoon) {
    text += `🌆 <b>Tushlikdan keyin:</b> ${c.afternoon.time}\n`;
    if (c.afternoon.lateMinutes > 0) text += `   ⏰ Kechikish: ${c.afternoon.lateMinutes} daqiqa\n`;
  } else {
    text += `🌆 Tushlik selfie: ❌ qilinmagan\n`;
  }
  if (a.note) text += `\n📝 ${a.note}\n`;
  return text;
}

// ═══ SHAXSIY OYLIK STATISTIKA ═══
async function buildPersonalStatsReport(chatId) {
  const phoneSnap = await db.ref(`tg_sessions/${chatId}/linkedPhone`).once("value");
  const phone = phoneSnap.val();
  if (!phone) return "❌ Tizimga kirmagansiz. /login bosing.";
  const rec = await lookupWhitelist(phone);
  if (!rec || !rec.name) return "❌ Profil topilmadi.";
  const empName = rec.name;
  const key = safeKey(empName);
  const now = new Date();
  const yr = parseInt(fmtDate(now).split("-")[0]);
  const mon = parseInt(fmtDate(now).split("-")[1]) - 1;
  const today = fmtDate(now);
  const dates = [];
  const d0 = new Date(yr, mon, 1);
  while (d0.getMonth() === mon && fmtDate(d0) <= today) {
    if (d0.getDay() >= 1 && d0.getDay() <= 5) dates.push(fmtDate(new Date(d0)));
    d0.setDate(d0.getDate() + 1);
  }
  // Single bulk fetch instead of N+1 — was 44 queries (22 days × 2), now just 2.
  const [allAttSnap, allCheckSnap] = await Promise.all([
    db.ref("attendance").orderByKey().startAt(dates[0] || today).endAt(today).once("value"),
    db.ref("checkins").orderByKey().startAt(dates[0] || today).endAt(today).once("value")
  ]);
  const allAtt = allAttSnap.val() || {};
  const allCheck = allCheckSnap.val() || {};
  let present = 0, late = 0, absent = 0, lateMins = 0, sababli = 0;
  for (const dk of dates) {
    const a = (allAtt[dk] && allAtt[dk][key]) || {};
    const c = allCheck[dk] && allCheck[dk][key];
    if (a.status && NON_WORKING.includes(a.status)) { sababli++; continue; }
    const hasSelfie = c && (c.morning || c.afternoon);
    if (hasSelfie || a.status === "present" || a.status === "late") {
      present++;
      const lm = (a.morning || 0) + (a.afternoon || 0);
      if (lm > 0) { late++; lateMins += lm; }
    } else {
      absent++;
    }
  }
  const workDays = dates.length - sababli;
  const score = Math.max(0, 100 - Math.round(lateMins / Math.max(1, workDays * 480) * 100 * 8) - absent * 5 - late * 2);
  const months = ["Yanvar","Fevral","Mart","Aprel","May","Iyun","Iyul","Avgust","Sentabr","Oktabr","Noyabr","Dekabr"];
  let text = `📊 <b>${empName}</b>\n📈 ${months[mon]} ${yr} oyi\n━━━━━━━━━━━━━━━━━━\n\n`;
  text += `📅 Ish kunlari: <b>${dates.length}</b>\n`;
  text += `✅ Kelgan: <b>${present}</b>\n`;
  text += `⏰ Kechikkan: <b>${late}</b> kun (${lateMins} daqiqa)\n`;
  text += `❌ Kelmagan: <b>${absent}</b>\n`;
  if (sababli > 0) text += `📋 Sababli: <b>${sababli}</b>\n`;
  text += `\n🎯 <b>Intizom bali: ${score}/100</b>\n`;
  if (score >= 95) text += "🏆 A'lo!";
  else if (score >= 85) text += "👍 Yaxshi";
  else if (score >= 70) text += "📈 O'rtacha";
  else text += "⚠️ Yaxshilash kerak";
  return text;
}

// ═══ AKTIV TA'TIL/SAFAR/BEMORLAR HISOBOTI ═══
// /tatil yoki /tatillar buyrug'i — bugungi sanada faol bo'lgan ta'til/safar/bemorlik kunlaridagi
// barcha xodimlarni va ularning intervallarini ko'rsatadi.
async function buildActiveLeavesReport(todayKey) {
  const STATUS_LABELS = {
    vacation: { icon: "🌴", label: "Ta'til" },
    trip: { icon: "✈️", label: "Xizmat safari" },
    sick: { icon: "🏥", label: "Bemor" },
    training: { icon: "📚", label: "Malaka oshirish" },
    excused: { icon: "📋", label: "Sababli" },
  };
  const TRACK = Object.keys(STATUS_LABELS);
  const todaySnap = await db.ref(`attendance/${todayKey}`).once("value");
  const today = todaySnap.val() || {};
  // Find all employees who have a tracked status today
  const activeEmps = Object.entries(today)
    .filter(([_, rec]) => rec && TRACK.includes(rec.status))
    .map(([empKey, rec]) => ({ empKey, status: rec.status }));
  if (activeEmps.length === 0) {
    return `🌴 <b>Hozirgi ta'til/safar/bemorlar</b>\n\n📅 ${todayKey}\n\n✅ Bugun barchasi ish joyida — ta'til/safar/bemorlikdagi xodim yo'q.`;
  }
  // For each active employee, find the consecutive range (start → end) of the same status
  const ranges = [];
  for (const { empKey, status } of activeEmps) {
    // Walk backwards
    let start = todayKey;
    for (let i = 1; i < 200; i++) {
      const d = new Date(todayKey + "T12:00:00"); d.setDate(d.getDate() - i);
      const dk = fmtDate(d);
      const snap = await db.ref(`attendance/${dk}/${empKey}/status`).once("value");
      if (snap.val() !== status) break;
      start = dk;
    }
    // Walk forwards
    let end = todayKey;
    for (let i = 1; i < 200; i++) {
      const d = new Date(todayKey + "T12:00:00"); d.setDate(d.getDate() + i);
      const dk = fmtDate(d);
      const snap = await db.ref(`attendance/${dk}/${empKey}/status`).once("value");
      if (snap.val() !== status) break;
      end = dk;
    }
    const days = Math.round((new Date(end + "T12:00:00") - new Date(start + "T12:00:00")) / 86400000) + 1;
    const passed = Math.round((new Date(todayKey + "T12:00:00") - new Date(start + "T12:00:00")) / 86400000) + 1;
    const remaining = days - passed;
    const emp = EMPLOYEES.find(e => safeKey(e) === empKey) || empKey.replace(/_/g, " ");
    ranges.push({ emp, status, start, end, days, passed, remaining });
  }
  // Group by status
  ranges.sort((a, b) => a.status.localeCompare(b.status) || (b.remaining - a.remaining));
  let text = `🌴 <b>Hozirgi ta'til / safar / bemorlar</b>\n\n📅 ${todayKey}\n👥 Jami: <b>${ranges.length}</b> nafar\n━━━━━━━━━━━━━━━━━━\n`;
  let curStatus = "";
  for (const r of ranges) {
    if (r.status !== curStatus) {
      const meta = STATUS_LABELS[r.status];
      text += `\n${meta.icon} <b>${meta.label}</b>\n`;
      curStatus = r.status;
    }
    const fmtDk = (s) => { const d = s.split("-"); return `${d[2]}.${d[1]}`; };
    text += `  • <b>${r.emp}</b>\n`;
    text += `    ${fmtDk(r.start)} → ${fmtDk(r.end)} (${r.days} kun)`;
    if (r.remaining > 0) text += ` · <b>${r.remaining}</b> kun qoldi`;
    else if (r.remaining === 0) text += ` · <b>oxirgi kun</b>`;
    text += `\n`;
  }
  return text;
}

// ═══ BULK LEAVE NOTIFY (HTTPS callable) ═══
// Sayt admin bulk leave (vacation/trip/sick/etc.) belgilaganda yoki bekor qilganda
// shu funksiya chaqiriladi va Telegram guruhga xabar yuboriladi.
exports.notifyBulkLeave = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Login required");
  }
  // Verify admin role
  const email = (context.auth.token.email || "").toLowerCase();
  const usersSnap = await db.ref("users").once("value");
  const users = usersSnap.val() || {};
  const isAdmin = Object.values(users).some(u =>
    (u && (u.email || "").toLowerCase() === email && (u.role === "admin" || u.role === "boss"))
  );
  if (!isAdmin) {
    throw new functions.https.HttpsError("permission-denied", "Admin only");
  }
  const chatId = await getChatId();
  if (!chatId) return { ok: false, reason: "no chat configured" };

  const { emp, status, fromDate, toDate, days, action } = data || {};
  if (!emp || !status || !fromDate) return { ok: false, reason: "missing data" };

  const STATUS_LABELS = {
    vacation: { icon: "🌴", label: "Ta'til" },
    trip: { icon: "✈️", label: "Xizmat safari" },
    sick: { icon: "🏥", label: "Bemorlik" },
    training: { icon: "📚", label: "Malaka oshirish" },
    excused: { icon: "📋", label: "Sababli yo'qlik" },
    absent: { icon: "❌", label: "Sababsiz yo'qlik" },
  };
  const meta = STATUS_LABELS[status] || { icon: "📅", label: status };
  const fmtDk = (s) => { const d = (s || "").split("-"); return d.length === 3 ? `${d[2]}.${d[1]}.${d[0]}` : s; };

  let text;
  if (action === "cancel") {
    text = `🔁 <b>${meta.label} bekor qilindi</b>\n\n👤 ${emp}\n📅 ${fmtDk(fromDate)} → ${fmtDk(toDate)} (${days} kun)\n\n👨‍💼 Admin: ${email}`;
  } else if (action === "edit") {
    text = `🔁 <b>${meta.label} yangilandi</b>\n\n👤 ${emp}\n${meta.icon} ${fmtDk(fromDate)} → ${fmtDk(toDate)} (${days} kun)\n\n👨‍💼 Admin: ${email}`;
  } else {
    text = `${meta.icon} <b>${meta.label}ga chiqdi</b>\n\n👤 ${emp}\n📅 ${fmtDk(fromDate)} → ${fmtDk(toDate)} (${days} kun)\n\n👨‍💼 Admin: ${email}`;
  }
  await sendMessage(chatId, text);
  return { ok: true };
});

// ═══ BOT i18n ═══
const BOT_T = {
  uz: {
    lang_picker: "🌐 Tilni tanlang / Выберите язык / Select language",
    welcome: "👋 <b>Xush kelibsiz!</b>\n\n🏢 Navoiy viloyati Investitsiyalar, sanoat va savdo boshqarmasi davomat tizimi.\n\nKerakli amalni tanlang:",
    menu_login: "🔐 Tizimga kirish",
    menu_reset: "🔄 Parolni tiklash",
    menu_info: "👤 Mening ma'lumotim",
    menu_site: "🌐 Saytni ochish",
    menu_open: "Tizimni ochish",
    menu_help: "❓ Yordam",
    menu_lang: "🌐 Tilni o'zgartirish",
    share_prompt: "📱 <b>Telefon raqamingizni ulashing</b>\n\nTizimga kirish uchun quyidagi tugmani bosing:",
    share_reset: "🔄 <b>Parolni tiklash</b>\n\nYangi parol olish uchun raqamingizni ulashing:",
    share_btn: "📱 Telefon raqamni ulashish",
    cancel: "❌ Bekor qilish",
    back: "⬅️ Ortga",
    not_found: "❌ Raqamingiz ro'yxatda topilmadi.\n\nIltimos, kadrlar bo'limiga murojaat qiling.",
    blocked: "🚫 Akkauntingiz bloklangan.\n\nAdmin bilan bog'laning.",
    success: "✅ Salom, <b>{name}</b>!\n{title}\n\n🔓 <b>Kirish ma'lumotlari:</b>\n\n📱 Login: <code>{phone}</code>\n🔑 Parol: <code>{password}</code>\n\n👇 Saytga kiring:",
    reset_success: "✅ <b>Parol yangilandi!</b>\n\n📱 Login: <code>{phone}</code>\n🔑 Yangi parol: <code>{password}</code>\n\n⚠️ Eski parol endi ishlamaydi.",
    info_line: "👤 <b>Sizning ma'lumotlaringiz:</b>\n\n🏷 Ism: <b>{name}</b>\n💼 Lavozim: {title}\n🎭 Rol: {role}\n📱 Telefon: <code>{phone}</code>\n📊 Holati: {status}",
    info_not_logged: "ℹ️ Siz hali tizimda ro'yxatdan o'tmagansiz.\n\n/start orqali kiring.",
    help: "🤖 <b>Yordam</b>\n\n🔐 /start — Tizimga kirish\n🔄 /reset — Parolni tiklash\n👤 /info — Mening ma'lumotim\n🌐 /lang — Tilni o'zgartirish\n❓ /help — Yordam\n\n📞 Qo'llab-quvvatlash: Kadrlar bo'limi",
    open_site: "🌐 Saytga o'tish",
    err: "⚠️ Xatolik yuz berdi. Qayta urinib ko'ring.",
  },
  ru: {
    lang_picker: "🌐 Выберите язык",
    welcome: "👋 <b>Добро пожаловать!</b>\n\n🏢 Система учёта посещаемости Управления инвестиций, промышленности и торговли Навоийской области.\n\nВыберите действие:",
    menu_login: "🔐 Вход в систему",
    menu_reset: "🔄 Сбросить пароль",
    menu_info: "👤 Моя информация",
    menu_site: "🌐 Открыть сайт",
    menu_open: "Открыть систему",
    menu_help: "❓ Помощь",
    menu_lang: "🌐 Сменить язык",
    share_prompt: "📱 <b>Поделитесь номером телефона</b>\n\nНажмите кнопку ниже:",
    share_reset: "🔄 <b>Сброс пароля</b>\n\nПоделитесь номером для получения нового:",
    share_btn: "📱 Поделиться номером",
    cancel: "❌ Отменить",
    back: "⬅️ Назад",
    not_found: "❌ Ваш номер не найден.\n\nОбратитесь в отдел кадров.",
    blocked: "🚫 Ваш аккаунт заблокирован.",
    success: "✅ Здравствуйте, <b>{name}</b>!\n{title}\n\n🔓 <b>Данные для входа:</b>\n\n📱 Логин: <code>{phone}</code>\n🔑 Пароль: <code>{password}</code>\n\n👇 Откройте сайт:",
    reset_success: "✅ <b>Пароль обновлён!</b>\n\n📱 Логин: <code>{phone}</code>\n🔑 Новый пароль: <code>{password}</code>\n\n⚠️ Старый пароль больше не работает.",
    info_line: "👤 <b>Ваши данные:</b>\n\n🏷 Имя: <b>{name}</b>\n💼 Должность: {title}\n🎭 Роль: {role}\n📱 Телефон: <code>{phone}</code>\n📊 Статус: {status}",
    info_not_logged: "ℹ️ Вы ещё не зарегистрированы.\n\nВведите /start для входа.",
    help: "🤖 <b>Помощь</b>\n\n🔐 /start — Вход\n🔄 /reset — Сброс пароля\n👤 /info — Моя информация\n🌐 /lang — Сменить язык\n❓ /help — Помощь",
    open_site: "🌐 Открыть сайт",
    err: "⚠️ Ошибка. Попробуйте снова.",
  },
  en: {
    lang_picker: "🌐 Select language",
    welcome: "👋 <b>Welcome!</b>\n\n🏢 Navoiy Region Investment, Industry & Trade Department — attendance system.\n\nChoose an action:",
    menu_login: "🔐 Login",
    menu_reset: "🔄 Reset password",
    menu_info: "👤 My info",
    menu_site: "🌐 Open website",
    menu_open: "Open system",
    menu_help: "❓ Help",
    menu_lang: "🌐 Change language",
    share_prompt: "📱 <b>Share your phone number</b>\n\nTap the button below:",
    share_reset: "🔄 <b>Reset password</b>\n\nShare your phone to get a new one:",
    share_btn: "📱 Share phone number",
    cancel: "❌ Cancel",
    back: "⬅️ Back",
    not_found: "❌ Your number is not registered.\n\nContact HR department.",
    blocked: "🚫 Your account is blocked.",
    success: "✅ Hello, <b>{name}</b>!\n{title}\n\n🔓 <b>Login credentials:</b>\n\n📱 Login: <code>{phone}</code>\n🔑 Password: <code>{password}</code>\n\n👇 Open website:",
    reset_success: "✅ <b>Password updated!</b>\n\n📱 Login: <code>{phone}</code>\n🔑 New password: <code>{password}</code>\n\n⚠️ Old password no longer works.",
    info_line: "👤 <b>Your information:</b>\n\n🏷 Name: <b>{name}</b>\n💼 Position: {title}\n🎭 Role: {role}\n📱 Phone: <code>{phone}</code>\n📊 Status: {status}",
    info_not_logged: "ℹ️ You are not registered yet.\n\nUse /start to sign in.",
    help: "🤖 <b>Help</b>\n\n🔐 /start — Sign in\n🔄 /reset — Reset password\n👤 /info — My info\n🌐 /lang — Change language\n❓ /help — Help",
    open_site: "🌐 Open website",
    err: "⚠️ Error. Try again.",
  },
};

async function getUserLang(chatId) {
  const snap = await db.ref(`tg_sessions/${chatId}/lang`).once("value");
  return snap.val() || "uz";
}
async function setUserLang(chatId, lang) {
  await db.ref(`tg_sessions/${chatId}`).update({ lang, mode: null });
}
async function setUserMode(chatId, mode) {
  await db.ref(`tg_sessions/${chatId}/mode`).set(mode);
}
async function getUserMode(chatId) {
  const snap = await db.ref(`tg_sessions/${chatId}/mode`).once("value");
  return snap.val();
}

function langKeyboard() {
  return { inline_keyboard: [
    [{ text: "🇺🇿 O'zbekcha", callback_data: "lang:uz" }],
    [{ text: "🇷🇺 Русский", callback_data: "lang:ru" }],
    [{ text: "🇬🇧 English", callback_data: "lang:en" }],
  ]};
}
function mainMenu(t) {
  // Vercel hosting — primary frontend (replaces Firebase Hosting + GitHub Pages).
  // Fast, public, no Service Worker, works well in Telegram Mini App.
  return { inline_keyboard: [
    [{ text: "🚀 " + (t.menu_open || "Tizimni ochish"), web_app: { url: "https://intizominvest.vercel.app/" } }],
    [{ text: t.menu_login, callback_data: "act:login" }],
    [{ text: t.menu_reset, callback_data: "act:reset" }],
    [{ text: t.menu_info, callback_data: "act:info" }],
    [{ text: t.menu_help, callback_data: "act:help" }, { text: t.menu_lang, callback_data: "act:lang" }],
  ]};
}

// Generate a one-time auto-login URL for the user behind chatId.
// Uses Firebase Custom Token — does NOT reset user's password (prevents kicking out other sessions).
// Returns null if user isn't linked yet (no whitelist entry for their phone).
async function buildMiniAppUrl(chatId) {
  try {
    const phoneSnap = await db.ref(`tg_sessions/${chatId}/linkedPhone`).once("value");
    const phone = phoneSnap.val();
    if (!phone) return null;
    const rec = await lookupWhitelist(phone);
    if (!rec || rec.active === false) return null;
    // Look up existing user — DON'T create new one or reset password
    const preferredEmail = (rec.linkEmail || "").toLowerCase().trim();
    const phoneEmail = phone.replace("+", "").replace(/\D/g, "") + "@intizom.uz";
    let user = null;
    if (preferredEmail) {
      try { user = await admin.auth().getUserByEmail(preferredEmail); } catch (_) {}
    }
    if (!user) {
      try { user = await admin.auth().getUserByEmail(phoneEmail); } catch (_) {}
    }
    if (!user) {
      // First-time user — create via ensureUser (which sets password)
      const created = await ensureUser({ ...rec, phone });
      user = await admin.auth().getUser(created.uid);
    }
    // Generate Firebase Custom Token — bypasses password, doesn't kick out other sessions
    const customToken = await admin.auth().createCustomToken(user.uid);
    const loginId = require("crypto").randomBytes(18).toString("hex");
    // Firebase rejects undefined values — default every field to safe value
    await db.ref(`tg_logins/${loginId}`).set({
      token: customToken,
      name: rec.name || user.displayName || phone || "",
      phone: phone || "",
      email: user.email || "",
      createdAt: Date.now(),
      expiresAt: Date.now() + 10 * 60 * 1000, // 10 min
      used: false,
    });
    return `https://intizominvest.vercel.app/?tg=${loginId}`;
  } catch (e) {
    console.error("buildMiniAppUrl:", e.message);
    return null;
  }
}
function shareKeyboard(t) {
  return { keyboard: [[{ text: t.share_btn, request_contact: true }]], resize_keyboard: true, one_time_keyboard: true };
}
async function sendMenu(chatId, lang) {
  const t = BOT_T[lang] || BOT_T.uz;
  await tgApi("sendMessage", {
    chat_id: chatId, text: t.welcome, parse_mode: "HTML", reply_markup: mainMenu(t),
  });
}

// ═══ TELEGRAM WEBHOOK ═══
exports.telegramWebhook = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") { res.status(200).send("OK"); return; }

  // Verify webhook secret on EVERY request (group AND DM)
  const secretSnap = await db.ref("config/webhook_secret").once("value");
  const webhookSecret = secretSnap.val();
  if (webhookSecret) {
    const headerSecret = req.headers["x-telegram-bot-api-secret-token"] || req.query.secret || "";
    if (headerSecret !== webhookSecret) {
      console.warn("[webhook] Secret mismatch — blocked");
      res.status(403).send("Forbidden");
      return;
    }
  }

  // ═══ CALLBACK QUERIES (inline keyboard) ═══
  const cbq = req.body?.callback_query;
  if (cbq) {
    try {
      const chatId = cbq.message.chat.id;
      const data = cbq.data || "";
      await tgApi("answerCallbackQuery", { callback_query_id: cbq.id });

      if (data.startsWith("lang:")) {
        const lang = data.split(":")[1];
        await setUserLang(chatId, lang);
        await sendMenu(chatId, lang);
        return res.status(200).send("OK");
      }
      if (data === "act:login" || data === "act:reset") {
        const lang = await getUserLang(chatId);
        const t = BOT_T[lang] || BOT_T.uz;
        await setUserMode(chatId, data === "act:reset" ? "reset" : "login");
        await tgApi("sendMessage", {
          chat_id: chatId,
          text: data === "act:reset" ? t.share_reset : t.share_prompt,
          parse_mode: "HTML",
          reply_markup: shareKeyboard(t),
        });
        return res.status(200).send("OK");
      }
      if (data === "act:info") {
        const lang = await getUserLang(chatId);
        const t = BOT_T[lang] || BOT_T.uz;
        // Check if user linked (by chatId → phone via tg_sessions)
        const userSnap = await db.ref(`tg_sessions/${chatId}/linkedPhone`).once("value");
        const phone = userSnap.val();
        if (!phone) {
          await tgApi("sendMessage", { chat_id: chatId, text: t.info_not_logged, parse_mode: "HTML" });
        } else {
          const rec = await lookupWhitelist(phone);
          if (rec) {
            const status = rec.active === false ? "🚫 Bloklangan" : "✅ Faol";
            const msg = t.info_line.replace("{name}", rec.name || "-").replace("{title}", rec.title || "-").replace("{role}", rec.role || "employee").replace("{phone}", phone).replace("{status}", status);
            await tgApi("sendMessage", { chat_id: chatId, text: msg, parse_mode: "HTML" });
          } else {
            await tgApi("sendMessage", { chat_id: chatId, text: t.info_not_logged, parse_mode: "HTML" });
          }
        }
        return res.status(200).send("OK");
      }
      if (data === "act:lang") {
        await tgApi("sendMessage", { chat_id: chatId, text: BOT_T.uz.lang_picker, reply_markup: langKeyboard() });
        return res.status(200).send("OK");
      }
      if (data === "act:help") {
        const lang = await getUserLang(chatId);
        const t = BOT_T[lang] || BOT_T.uz;
        await tgApi("sendMessage", { chat_id: chatId, text: t.help, parse_mode: "HTML", reply_markup: mainMenu(t) });
        return res.status(200).send("OK");
      }
      return res.status(200).send("OK");
    } catch (e) {
      console.error("Callback error:", e);
      return res.status(200).send("OK");
    }
  }

  const message = req.body?.message;
  if (!message) { res.status(200).send("OK"); return; }

  const chatId = message.chat.id;
  const cmd = (message.text || "").trim().split(" ")[0].split("@")[0].toLowerCase();
  const todayKey = fmtDate(new Date());

  const isGroup = message.chat.type === "group" || message.chat.type === "supergroup";

  try {
    let reply = "";

    if (!isGroup) {
      const userLang = await getUserLang(chatId);
      const t = BOT_T[userLang] || BOT_T.uz;

      // ═══ CONTACT SHARE = LOGIN / RESET ═══
      if (message.contact) {
        if (message.contact.user_id && message.contact.user_id !== message.from.id) {
          await tgApi("sendMessage", { chat_id: chatId, text: "⚠️ Faqat o'z raqamingizni ulashing!" });
          return res.status(200).send("OK");
        }
        const phone = normalizePhone(message.contact.phone_number);
        const rec = await lookupWhitelist(phone);
        if (!rec) {
          await tgApi("sendMessage", { chat_id: chatId, text: t.not_found, reply_markup: { remove_keyboard: true } });
          return res.status(200).send("OK");
        }
        if (rec.active === false) {
          await tgApi("sendMessage", { chat_id: chatId, text: t.blocked, reply_markup: { remove_keyboard: true } });
          return res.status(200).send("OK");
        }
        const { tempPassword } = await ensureUser({ ...rec, phone });
        const appUrl = "https://intizominvest.vercel.app/";
        const roleLabel = rec.title || (rec.role === "admin" ? "Kadrlar bo'limi" : rec.role === "boss" ? "Rahbar" : rec.role === "observer" ? "Kuzatuvchi" : "Xodim");
        const mode = await getUserMode(chatId);
        await db.ref(`tg_sessions/${chatId}/linkedPhone`).set(phone);
        await setUserMode(chatId, null);

        const template = mode === "reset" ? t.reset_success : t.success;
        const msg = template
          .replace("{name}", rec.name || "-")
          .replace("{title}", roleLabel)
          .replace(/\{phone\}/g, phone)
          .replace(/\{password\}/g, tempPassword);
        await tgApi("sendMessage", {
          chat_id: chatId, text: msg, parse_mode: "HTML", disable_web_page_preview: true,
          reply_markup: { inline_keyboard: [[{ text: t.open_site, url: appUrl }]], remove_keyboard: true },
        });
        await tgApi("sendMessage", {
          chat_id: chatId, text: t.welcome, parse_mode: "HTML",
          reply_markup: mainMenu(t),
        });
        return res.status(200).send("OK");
      }

      // Shaxsiy chat — buyruqlar
      switch (cmd) {
        case "/start":
          // Show language picker on first start
          const langSnap = await db.ref(`tg_sessions/${chatId}/lang`).once("value");
          if (!langSnap.val()) {
            await tgApi("sendMessage", { chat_id: chatId, text: BOT_T.uz.lang_picker, reply_markup: langKeyboard() });
          } else {
            await sendMenu(chatId, userLang);
          }
          return res.status(200).send("OK");
        case "/login": case "/kirish":
          await setUserMode(chatId, "login");
          await tgApi("sendMessage", { chat_id: chatId, text: t.share_prompt, parse_mode: "HTML", reply_markup: shareKeyboard(t) });
          return res.status(200).send("OK");
        case "/reset": case "/parol":
          await setUserMode(chatId, "reset");
          await tgApi("sendMessage", { chat_id: chatId, text: t.share_reset, parse_mode: "HTML", reply_markup: shareKeyboard(t) });
          return res.status(200).send("OK");
        case "/info": case "/menda":
          const userSnap = await db.ref(`tg_sessions/${chatId}/linkedPhone`).once("value");
          const phone = userSnap.val();
          if (!phone) {
            await tgApi("sendMessage", { chat_id: chatId, text: t.info_not_logged, parse_mode: "HTML", reply_markup: mainMenu(t) });
          } else {
            const rec = await lookupWhitelist(phone);
            if (rec) {
              const status = rec.active === false ? "🚫 Bloklangan" : "✅ Faol";
              const msg = t.info_line
                .replace("{name}", rec.name || "-").replace("{title}", rec.title || "-")
                .replace("{role}", rec.role || "employee").replace("{phone}", phone).replace("{status}", status);
              await tgApi("sendMessage", { chat_id: chatId, text: msg, parse_mode: "HTML", reply_markup: mainMenu(t) });
            } else {
              await tgApi("sendMessage", { chat_id: chatId, text: t.info_not_logged, parse_mode: "HTML" });
            }
          }
          return res.status(200).send("OK");
        case "/lang": case "/til":
          await tgApi("sendMessage", { chat_id: chatId, text: BOT_T.uz.lang_picker, reply_markup: langKeyboard() });
          return res.status(200).send("OK");
        case "/yordam": case "/help":
          await tgApi("sendMessage", { chat_id: chatId, text: t.help, parse_mode: "HTML", reply_markup: mainMenu(t) });
          return res.status(200).send("OK");
        // ═══ Shaxsiy buyruqlar (DM'da xodim o'zining ma'lumotlarini olishi uchun) ═══
        case "/mendavomat": case "/menpda":
          await tgApi("sendMessage", { chat_id: chatId, text: await buildPersonalAttendanceReport(chatId, todayKey), parse_mode: "HTML" });
          return res.status(200).send("OK");
        case "/menstat":
          await tgApi("sendMessage", { chat_id: chatId, text: await buildPersonalStatsReport(chatId), parse_mode: "HTML" });
          return res.status(200).send("OK");
        case "/davomat":
        case "/tatil": case "/tatillar":
        case "/kechikkanlar":
        case "/statistika":
        case "/xodimlar":
        case "/qidir":
        case "/tugilgan": {
          // Faqat admin/boss/observer DM'da bu hisobotlarni ko'ra oladi.
          // Oddiy xodim — /menpda yoki /menstat ishlatadi.
          const phoneSnap2 = await db.ref(`tg_sessions/${chatId}/linkedPhone`).once("value");
          const phone2 = phoneSnap2.val();
          const rec2 = phone2 ? await lookupWhitelist(phone2) : null;
          const role = rec2 && rec2.role;
          if (!role || !["admin","boss","observer"].includes(role)) {
            await tgApi("sendMessage", { chat_id: chatId, text: "🚫 Bu buyruq faqat admin/rahbar uchun.\n\nShaxsiy buyruqlar: /menpda, /menstat, /menda" });
            return res.status(200).send("OK");
          }
          // Authorized — process command
          let txt = "";
          const cmdParts2 = (message.text || "").trim().split(/\s+/);
          const arg2 = cmdParts2.slice(1).join(" ").trim();
          if (cmd === "/davomat") txt = await buildDavomatReport(todayKey);
          else if (cmd === "/tatil" || cmd === "/tatillar") txt = await buildActiveLeavesReport(todayKey);
          else if (cmd === "/kechikkanlar") txt = await buildKechikkanlarReport(todayKey);
          else if (cmd === "/statistika") txt = await buildStatistikaReport();
          else if (cmd === "/xodimlar") txt = await buildEmployeeListReport();
          else if (cmd === "/tugilgan") txt = await buildBirthdaysReport();
          else if (cmd === "/qidir") txt = arg2 ? await buildEmployeeSearchReport(arg2, todayKey) : "🔍 Foydalanish: <code>/qidir Saidov</code>";
          await tgApi("sendMessage", { chat_id: chatId, text: txt, parse_mode: "HTML" });
          return res.status(200).send("OK");
        }
        default:
          await sendMenu(chatId, userLang);
          return res.status(200).send("OK");
      }
    } else {
      // Guruh chat — davomat buyruqlari ishlaydi
      const cmdParts = (message.text || "").trim().split(/\s+/);
      const arg = cmdParts.slice(1).join(" ").trim();
      switch (cmd) {
        case "/davomat": case "/start":
          reply = await buildDavomatReport(todayKey); break;
        case "/kechikkanlar":
          reply = await buildKechikkanlarReport(todayKey); break;
        case "/statistika":
          reply = await buildStatistikaReport(); break;
        case "/tatil": case "/tatillar": case "/leaves":
          reply = await buildActiveLeavesReport(todayKey); break;
        case "/xodimlar": case "/employees":
          reply = await buildEmployeeListReport(); break;
        case "/qidir": case "/search":
          reply = arg ? await buildEmployeeSearchReport(arg, todayKey)
                      : "🔍 <b>Qidiruv</b>\n\nFoydalanish: <code>/qidir Saidov</code>";
          break;
        case "/tugilgan": case "/birthdays":
          reply = await buildBirthdaysReport(); break;
        case "/yordam": case "/help":
          reply = botHelpText(); break;
        default: res.status(200).send("OK"); return;
      }
    }
    await sendMessage(chatId, reply);
  } catch (err) {
    console.error("Webhook error:", err);
    await sendMessage(chatId, "⚠ Xatolik yuz berdi.").catch(() => {});
  }
  res.status(200).send("OK");
});

// ═══ KUNLIK HISOBOT — 18:00 Dush-Juma ═══
exports.dailyReport = functions.pubsub
  .schedule("0 18 * * 1-5").timeZone("Asia/Tashkent")
  .onRun(async () => {
    const chatId = await getChatId();
    if (!chatId) return null;
    await sendMessage(chatId, await buildDavomatReport(fmtDate(new Date())));
    return null;
  });

// ═══ ABSENT BILDIRISHNOMA ═══
exports.onAttendanceChange = functions.database
  .ref("attendance/{dateKey}/{empKey}")
  .onWrite(async (change, context) => {
    const chatId = await getChatId();
    if (!chatId) return null;
    const after = change.after.val();
    const before = change.before.val();
    if (!after) return null;
    const empKey = context.params.empKey;
    const dateKey = context.params.dateKey;
    const emp = EMPLOYEES.find(e => safeKey(e) === empKey) || empKey;
    const d = dateKey.split("-");
    if (after.status === "absent" && (!before || before.status !== "absent")) {
      await sendMessage(chatId, `❌ <b>Sababsiz yo'qlik</b>\n\n👤 <b>${emp}</b>\n📅 ${d[2]}.${d[1]}.${d[0]}`);
    }
    return null;
  });

// ═══ SELFIE → ATTENDANCE AVTOMATIK YOZISH ═══
// Xodim selfie tushganda checkins ga yoziladi, shu trigger attendance ni ham yangilaydi
// Haversine GPS distance in meters
function gpsDistanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

exports.onCheckinWrite = functions.database
  .ref("checkins/{dateKey}/{empKey}/{session}")
  .onCreate(async (snapshot, context) => {
    const { dateKey, empKey, session } = context.params;
    const checkin = snapshot.val();
    if (!checkin) return null;

    // ═══ SERVER-SIDE GPS VALIDATION ═══
    try {
      const officeSnap = await db.ref("office_location").once("value");
      const office = officeSnap.val();
      if (office && typeof checkin.gpsLat === "number" && typeof checkin.gpsLng === "number") {
        const dist = gpsDistanceMeters(office.lat, office.lng, checkin.gpsLat, checkin.gpsLng);
        const radius = office.radius || 300;
        const serverGpsOk = dist <= radius;
        // Override client-sent values — prevent GPS spoofing
        if (checkin.gpsOk !== serverGpsOk || Math.abs((checkin.gpsDistance || 0) - dist) > 10) {
          await snapshot.ref.update({
            gpsOk: serverGpsOk,
            gpsDistance: Math.round(dist),
            serverValidated: true,
          });
        }
      }
    } catch (e) {
      console.warn("GPS validation failed:", e.message);
    }

    // ═══ SERVER-SIDE LATE-MINUTES CALCULATION ═══
    let lateMinutes = 0;
    const timeStr = checkin.time || "";
    try {
      const [hh, mm] = timeStr.split(":").map(Number);
      if (!isNaN(hh) && !isNaN(mm)) {
        const totalMin = hh * 60 + mm;
        const deadlineMin = session === "morning" ? (9 * 60 + 10) : (14 * 60 + 10);
        lateMinutes = Math.max(0, totalMin - deadlineMin);
        if (lateMinutes !== (checkin.lateMinutes || 0)) {
          await snapshot.ref.update({ lateMinutes });
        }
      }
    } catch (_) {}

    // Mavjud attendance recordni olish
    const attRef = db.ref(`attendance/${dateKey}/${empKey}`);
    const attSnap = await attRef.once("value");
    const existing = attSnap.val() || { status: "present", morning: 0, afternoon: 0, note: "" };

    const updates = {};
    const notePrefix = checkin.empNote ? " — " + checkin.empNote : "";

    if (session === "morning") {
      updates.morning = lateMinutes;
      updates.status = lateMinutes > 0 ? "late" : "present";
      const label = lateMinutes === 0
        ? "Ertalab selfie (09:10 gacha): "
        : "Selfie 09:10 dan keyin: ";
      updates.note = (existing.note ? existing.note + " | " : "") + label + timeStr + notePrefix;
    } else if (session === "afternoon") {
      updates.afternoon = lateMinutes;
      if (lateMinutes > 0 || existing.morning > 0) updates.status = "late";
      const label = lateMinutes === 0
        ? "Tushlikdan keyingi selfie (14:10 gacha): "
        : "Selfie 14:10 dan keyin: ";
      updates.note = (existing.note ? existing.note + " | " : "") + label + timeStr + notePrefix;
    }

    await attRef.update(updates);
    return null;
  });

// ═══ birthdayNotify (08:00 har kun) — DELETED 2026-04-27 per user request ═══
// User asked to remove daily-recurring scheduled messages.


// ═══ morningSelfieCheck (09:20 har ish kuni) — DELETED 2026-05-02 per user request ═══
// User asked to stop daily 09:20 selfie report message.
// ═══ afternoonSelfieCheck (14:20 har ish kuni) — DELETED 2026-05-02 per user request ═══
// User asked to stop daily 14:20 selfie report message.
// ═══ HAFTALIK HISOBOT — Juma 17:00 ═══
exports.weeklyReport = functions.pubsub
  .schedule("0 17 * * 5").timeZone("Asia/Tashkent")
  .onRun(async () => {
    const chatId = await getChatId();
    if (!chatId) return null;
    const now = new Date();
    const monday = new Date(now);
    monday.setDate(now.getDate() - (now.getDay() - 1));
    const weekDates = [];
    for (let i = 0; i < 5; i++) {
      const d = new Date(monday); d.setDate(monday.getDate() + i);
      weekDates.push(fmtDate(d));
    }
    const [attSnap, checkSnap] = await Promise.all([
      db.ref("attendance").once("value"),
      db.ref("checkins").once("value")
    ]);
    const allAtt = attSnap.val() || {};
    const allCheckins = checkSnap.val() || {};
    let totalPresent = 0, totalLate = 0, totalAbsent = 0, totalSick = 0, totalVacation = 0, totalLateMins = 0;
    const empResults = [];
    EMPLOYEES.forEach(emp => {
      let present = 0, late = 0, absent = 0, lateMins = 0, workDays = 0;
      weekDates.forEach(dk => {
        const key = safeKey(emp);
        const att = allAtt[dk]?.[key];
        const check = allCheckins[dk]?.[key];
        const status = att?.status;
        if (status && NON_WORKING.includes(status)) {
          if (status === "sick") totalSick++;
          if (status === "vacation") totalVacation++;
          return;
        }
        workDays++;
        const hasSelfie = check && (check.morning || check.afternoon);
        if (hasSelfie || status === "present" || status === "late") {
          present++;
          if (status === "late" || (att?.morning || 0) + (att?.afternoon || 0) > 0) late++;
          lateMins += (att?.morning || 0) + (att?.afternoon || 0);
        } else { absent++; }
      });
      totalPresent += present; totalLate += late; totalAbsent += absent; totalLateMins += lateMins;
      const score = Math.max(0, 100 - Math.round(lateMins / Math.max(1, workDays * 480) * 100 * 8) - absent * 5 - late * 2);
      empResults.push({ name: emp, present, late, absent, lateMins, score });
    });
    empResults.sort((a, b) => b.score - a.score);
    const avgScore = Math.round(empResults.reduce((s, e) => s + e.score, 0) / Math.max(1, EMPLOYEES.length));
    const monDate = weekDates[0].split("-");
    const friDate = weekDates[4].split("-");
    let text = `📋 <b>Haftalik hisobot</b>\n`;
    text += `📅 ${monDate[2]}.${monDate[1]} — ${friDate[2]}.${friDate[1]}.${friDate[0]}\n`;
    text += `━━━━━━━━━━━━━━━━━━\n`;
    text += `✅ Kelgan: <b>${totalPresent}</b>/${5 * EMPLOYEES.length}\n`;
    text += `⏰ Kechikish: <b>${totalLate}</b>\n`;
    text += `❌ Kelmagan: <b>${totalAbsent}</b>\n`;
    if (totalSick > 0) text += `🏥 Bemor: <b>${totalSick}</b>\n`;
    if (totalVacation > 0) text += `🌴 Ta'til: <b>${totalVacation}</b>\n`;
    text += `🕐 Jami kechikish: <b>${fmtMins(totalLateMins)}</b>\n`;
    text += `🎯 Intizom: <b>${avgScore}/100</b>\n`;
    text += `━━━━━━━━━━━━━━━━━━\n\n`;
    text += `🏆 <b>Eng yaxshilar:</b>\n`;
    ["🥇","🥈","🥉"].forEach((m, i) => {
      if (empResults[i]) text += `${m} ${empResults[i].name} — <b>${empResults[i].score}</b>\n`;
    });
    const worst = empResults.filter(e => e.score < 100).slice(-3).reverse();
    if (worst.length > 0) {
      text += `\n⚠️ <b>Diqqatga muhtoj:</b>\n`;
      worst.forEach(e => {
        const r = [];
        if (e.late > 0) r.push(`${e.late} kechikish`);
        if (e.absent > 0) r.push(`${e.absent} yo'qlik`);
        if (e.lateMins > 0) r.push(fmtMins(e.lateMins));
        text += `  ⚡ ${e.name} — ${e.score} (${r.join(", ")})\n`;
      });
    }
    text += `\n📍 Navoiy viloyati Investitsiyalar, sanoat va savdo boshqarmasi`;
    await sendMessage(chatId, text);
    return null;
  });

// ═══ AI TAHLIL (GEMINI) ═══
// API kalit Firebase DB'dan olinadi — kodda saqlanmaydi
const ALLOWED_ORIGINS = [
  "https://lazizbeksaidov.github.io"
];

exports.aiAnalysis = functions.https.onRequest(async (req, res) => {
  // CORS — faqat ruxsat berilgan saytlardan
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.some(o => origin === o)) {
    res.set("Access-Control-Allow-Origin", origin);
  }
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "DENY");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") { res.status(405).json({error:"POST only"}); return; }

  // Auth check — faqat admin/boss
  const authHeader = req.headers.authorization || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!idToken) { res.status(401).json({error:"Unauthorized"}); return; }
  const ADMIN_EMAILS = ["kadr@boshqarma.uz"];
  const BOSS_EMAILS = ["ravshan.azimov@boshqarma.uz", "elbek.gafforov@boshqarma.uz"];
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const email = (decoded.email || "").toLowerCase();
    if (!ADMIN_EMAILS.includes(email) && !BOSS_EMAILS.includes(email)) {
      res.status(403).json({error:"Ruxsat yo'q"}); return;
    }
  } catch (e) {
    res.status(401).json({error:"Invalid token"}); return;
  }

  const { question, employeeName, mode } = req.body;
  if (!question && !employeeName) { res.status(400).json({error:"question yoki employeeName kerak"}); return; }

  try {
    // Ma'lumotlarni Firebase'dan olish
    const now = new Date();
    const yr = now.getFullYear();
    const mon = now.getMonth();
    const dates = [];
    const d = new Date(yr, mon, 1);
    while (d.getMonth() === mon && fmtDate(d) <= fmtDate(now)) {
      if (d.getDay() >= 1 && d.getDay() <= 5) dates.push(fmtDate(new Date(d)));
      d.setDate(d.getDate() + 1);
    }

    const [attSnap, checkSnap] = await Promise.all([
      db.ref("attendance").once("value"),
      db.ref("checkins").once("value")
    ]);
    const allAtt = attSnap.val() || {};
    const allCheckins = checkSnap.val() || {};

    // Xodimlar statistikasini yig'ish
    const empStats = [];
    const targetEmps = employeeName ? EMPLOYEES.filter(e => e.toLowerCase().includes(employeeName.toLowerCase())) : EMPLOYEES;

    targetEmps.forEach(emp => {
      const key = safeKey(emp);
      let present = 0, late = 0, absent = 0, sick = 0, vacation = 0, trip = 0, lateMins = 0;
      const dailyDetails = [];
      dates.forEach(dk => {
        const att = allAtt[dk]?.[key];
        const check = allCheckins[dk]?.[key];
        const status = att?.status;
        const hasMorning = check?.morning ? true : false;
        const hasAfternoon = check?.afternoon ? true : false;
        const hasSelfie = hasMorning || hasAfternoon;
        const morningMin = att?.morning || 0;
        const afternoonMin = att?.afternoon || 0;

        let dayStatus = "noaniq";
        if (status && NON_WORKING.includes(status)) {
          if (status === "sick") { sick++; dayStatus = "bemor"; }
          else if (status === "vacation") { vacation++; dayStatus = "ta'til"; }
          else if (status === "trip") { trip++; dayStatus = "xizmat safari"; }
          else { dayStatus = status; }
        } else if (hasSelfie || status === "present" || status === "late") {
          present++;
          if (status === "late" || morningMin + afternoonMin > 0) {
            late++;
            lateMins += morningMin + afternoonMin;
            dayStatus = `kechikkan (${morningMin + afternoonMin} daq)`;
          } else { dayStatus = "kelgan"; }
        } else { absent++; dayStatus = "kelmagan"; }
        dailyDetails.push({ sana: dk, holat: dayStatus, ertalab_selfie: hasMorning, tushlik_selfie: hasAfternoon });
      });
      empStats.push({ ism: emp, kelgan: present, kechikkan: late, kelmagan: absent, bemor: sick, tatil: vacation, safar: trip, kechikish_daqiqa: lateMins, kunlik: dailyDetails });
    });

    const months = ["Yanvar","Fevral","Mart","Aprel","May","Iyun","Iyul","Avgust","Sentabr","Oktabr","Noyabr","Dekabr"];

    // Gemini uchun prompt
    let prompt = "";
    if (mode === "monthly") {
      prompt = `Sen — Navoiy viloyati Investitsiyalar boshqarmasi xodimlar intizomi bo'yicha mutaxassissan. ${months[mon]} ${yr} oyi uchun umumiy oylik tahlil ber.

Xodimlar soni: ${EMPLOYEES.length}
O'tgan ish kunlari: ${dates.length}

Xodimlar ma'lumoti:
${JSON.stringify(empStats, null, 1)}

Quyidagilarni o'zbek tilida tahlil qil:
1. Umumiy intizom holati (foizlarda)
2. Eng intizomli 3 xodim va sababi
3. Eng ko'p muammo ko'rilgan 3 xodim va sababi
4. Kechikish tendensiyasi (qaysi kunlarda ko'p?)
5. Aniq tavsiyalar (rahbariyat uchun)

Professional, qisqa va aniq yoz. Raqamlar bilan asosla.`;
    } else if (employeeName && targetEmps.length > 0) {
      prompt = `Sen — Navoiy viloyati Investitsiyalar va tashqi savdo boshqarmasi xodimlar intizomi bo'yicha yuqori malakali AI tahlilchisan.

Tahlil davri: ${months[mon]} ${yr}
Jami ish kunlari: ${dates.length} kun

"${targetEmps[0]}" xodimining TO'LIQ ma'lumoti:
${JSON.stringify(empStats[0], null, 1)}

Boshqa xodimlar bilan solishtirish uchun umumiy statistika:
${JSON.stringify(empStats.map(e => ({ism: e.ism, kelgan: e.kelgan, kechikkan: e.kechikkan, kelmagan: e.kelmagan, kechikish_daqiqa: e.kechikish_daqiqa})), null, 1)}

Quyidagilarni o'zbek tilida CHUQUR tahlil qil:
1. DAVOMAT HOLATI — necha kun keldi, kelmadi, foizlarda ko'rsat, boshqalar bilan solishtir
2. KECHIKISH TAHLILI — jami necha marta, jami necha daqiqa, qaysi kunlarda ko'p, tendensiya
3. SELFIE INTIZOMI — ertalab va tushlik selfilarni har kun tekshir, qaysi kunlari olmagan
4. KUNLIK XARITA — har bir ish kunini qisqacha ko'rsat (keldi/kelmadi/kechikdi)
5. KUCHLI TOMONLARI — aniq faktlarga asoslangan
6. TAVSIYALAR — aniq va amaliy tavsiyalar
7. UMUMIY BAL — 100 ballik tizimda baho ber va asosla

${question ? "Qo'shimcha savol: " + question : ""}

MUHIM: Har bir da'voni raqam bilan asosla. O'ylab topma, faqat yuqoridagi ma'lumotga asoslan.`;
    } else {
      prompt = `Sen — Navoiy viloyati Investitsiyalar va tashqi savdo boshqarmasi xodimlar intizomi bo'yicha yuqori malakali AI tahlilchisan. Sening vazifang — aniq raqamlar va faktlarga asoslangan chuqur tahlil berish.

Hozirgi sana: ${fmtDate(now)}
Tahlil davri: ${months[mon]} ${yr}
Jami xodimlar: ${EMPLOYEES.length} nafar
O'tgan ish kunlari: ${dates.length} kun

BARCHA xodimlar statistikasi:
${JSON.stringify(empStats, null, 1)}

Foydalanuvchi savoli: ${question}

MUHIM QOIDALAR:
- Faqat yuqoridagi ma'lumotlarga asoslan, o'ylab topma
- Har bir da'voni aniq raqam bilan asosla (masalan: "21 kundan 18 kun kelgan — 85.7%")
- Agar savol aniq xodim haqida bo'lsa, uning kunlik ma'lumotlarini chuqur tahlil qil
- Agar umumiy savol bo'lsa, barcha xodimlarni solishtir va reyting ber
- Kechikish daqiqalarini aniq ko'rsat
- Selfie intizomini (ertalab/tushlik) ham tekshir
- Professional, tizimli va o'zbek tilida javob ber
- Zarur bo'lsa jadval ko'rinishida ma'lumot ber
- Qisqa emas, to'liq va chuqur tahlil ber`;
    }

    // Gemini API call — kalit Firebase DB'dan xavfsiz olinadi
    const keySnap = await db.ref("config/gemini_key").once("value");
    const geminiKey = keySnap.val();
    if (!geminiKey) { res.status(500).json({error:"AI kalit sozlanmagan"}); return; }

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`;
    const geminiRes = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" }
        ]
      })
    });

    const geminiData = await geminiRes.json();
    if (geminiData.error) {
      res.status(500).json({ error: geminiData.error.message }); return;
    }

    const answer = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "Javob olinmadi";
    res.json({ answer, model: "gemini-2.5-flash" });
  } catch (err) {
    console.error("AI Analysis error:", err);
    res.status(500).json({ error: "AI tahlilda xatolik: " + err.message });
  }
});

// ═══ TELEGRAM NOTIFY — Frontend orqali xabar yuborish ═══
exports.sendTelegramNotify = functions.https.onRequest(async (req, res) => {
  // CORS — faqat ruxsat berilgan saytlardan (aiAnalysis bilan bir xil)
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.some(o => origin === o)) {
    res.set("Access-Control-Allow-Origin", origin);
  }
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "DENY");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

  // Auth check — faqat admin/boss
  const authHeader = req.headers.authorization || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!idToken) { res.status(401).json({ error: "Unauthorized" }); return; }
  const ADMIN_EMAILS = ["kadr@boshqarma.uz"];
  const BOSS_EMAILS = ["ravshan.azimov@boshqarma.uz", "elbek.gafforov@boshqarma.uz"];
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const email = (decoded.email || "").toLowerCase();
    if (!ADMIN_EMAILS.includes(email) && !BOSS_EMAILS.includes(email)) {
      res.status(403).json({ error: "Ruxsat yo'q" }); return;
    }
  } catch (e) {
    res.status(401).json({ error: "Invalid token" }); return;
  }

  const { text, parseMode } = req.body;
  if (!text) { res.status(400).json({ error: "text maydoni kerak" }); return; }

  try {
    // Bot token va chatId ni Firebase DB dan olish
    const [tokenSnap, chatIdSnap] = await Promise.all([
      db.ref("config/bot_token").once("value"),
      db.ref("telegram_config/chatId").once("value")
    ]);
    const botToken = tokenSnap.val();
    const chatId = chatIdSnap.val();

    if (!botToken) { res.status(500).json({ error: "Bot token sozlanmagan" }); return; }
    if (!chatId) { res.status(500).json({ error: "Chat ID sozlanmagan" }); return; }

    const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const telegramRes = await fetch(telegramUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: parseMode || "HTML",
        disable_web_page_preview: true
      })
    });
    const telegramData = await telegramRes.json();

    if (!telegramData.ok) {
      res.status(500).json({ error: "Telegram xatolik: " + (telegramData.description || "Noma'lum") }); return;
    }

    res.json({ success: true, message_id: telegramData.result?.message_id });
  } catch (err) {
    console.error("sendTelegramNotify error:", err);
    res.status(500).json({ error: "Xabar yuborishda xatolik: " + err.message });
  }
});

// ═══ USER ROLES — Login qilganda rolni DB ga yozish ═══
exports.setUserRole = functions.https.onRequest(async (req, res) => {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.some(o => origin === o)) {
    res.set("Access-Control-Allow-Origin", origin);
  }
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") { res.status(405).json({error:"POST only"}); return; }

  const authHeader = req.headers.authorization || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!idToken) { res.status(401).json({error:"Unauthorized"}); return; }

  const ADMIN_EMAILS = ["kadr@boshqarma.uz"];
  const BOSS_EMAILS = ["ravshan.azimov@boshqarma.uz", "elbek.gafforov@boshqarma.uz"];
  const OBSERVER_EMAILS = [];

  try {
    const decoded = await admin.auth().verifyIdToken(idToken, true);
    const email = (decoded.email || "").toLowerCase();
    const uid = decoded.uid;
    const emailVerified = decoded.email_verified === true;

    // Security: check existing role first — never demote or elevate arbitrarily
    const existingSnap = await db.ref(`user_roles/${uid}`).once("value");
    const existing = existingSnap.val();

    let role;
    // 1) Hardcoded admin/boss list (highest priority)
    if (ADMIN_EMAILS.includes(email) && emailVerified) role = "admin";
    else if (BOSS_EMAILS.includes(email) && emailVerified) role = "boss";
    else if (OBSERVER_EMAILS.includes(email) && emailVerified) role = "observer";
    else {
      // 2) Lookup whitelist by linkEmail to find canonical role
      try {
        const wlSnap = await db.ref("whitelist").once("value");
        const wl = wlSnap.val() || {};
        for (const k in wl) {
          const rec = wl[k];
          if (rec && (rec.linkEmail || "").toLowerCase() === email) {
            role = rec.role || "employee";
            break;
          }
        }
      } catch (_) {}
      // 3) Fallback: preserve existing or default to employee
      if (!role) role = existing || "employee";
    }

    // Never downgrade admin → employee automatically
    if (existing === "admin" && role !== "admin") role = "admin";

    await db.ref(`user_roles/${uid}`).set(role);
    res.json({ success: true, role });
  } catch (e) {
    console.error("setUserRole error:", e.code || e.message);
    res.status(401).json({ error: "Invalid token" });
  }
});


/* ═══════════════════════════════════════════════════════════ */
/* 🔐 TELEGRAM LOGIN BOT                                        */
/* Xodimlar Telegram orqali kirish                              */
/* ═══════════════════════════════════════════════════════════ */

const TG_LOGIN_PATH = "config/login_bot";

async function getLoginBotToken() {
  const snap = await db.ref(TG_LOGIN_PATH + "/bot_token").once("value");
  return snap.val();
}

// tgApi uses MAIN bot token (for @navinvestmonitoring_bot webhook)
async function tgApi(method, body) {
  const token = await getBotToken();
  if (!token) throw new Error("Main bot token not configured");
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return await res.json();
}

// Login bot token (eski) — faqat telegramLoginBot funksiyasi uchun
async function tgApiLogin(method, body) {
  const token = await getLoginBotToken();
  if (!token) throw new Error("Login bot token not configured");
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return await res.json();
}

// ——— Translations ———
const TG_T = {
  uz: {
    welcome: "👋 Xush kelibsiz!\n\nIntizom tizimiga kirish uchun telefon raqamingizni ulashing:",
    lang_prompt: "🌐 Tilni tanlang / Выберите язык / Select language",
    share_phone: "📱 Telefon raqamni ulashish",
    not_found: "❌ Raqamingiz ro'yxatda topilmadi.\n\nIltimos, kadrlar bo'limiga murojaat qiling.",
    blocked: "🚫 Akkauntingiz bloklangan.\n\nAdmin bilan bog'laning.",
    success: "✅ Salom, {name}!\n{title}\n\n🔓 <b>Kirish ma'lumotlaringiz:</b>\n\n📱 Login: <code>{phone}</code>\n🔑 Parol: <code>{password}</code>\n\n👇 Quyidagi tugma orqali saytga kiring yoki <a href=\"{url}\">{url}</a>\n\n<i>⚠️ Parolni saqlab qo'ying yoki kirgandan keyin Sozlamalarda o'zgartiring.</i>",
    open_app: "🌐 Saytga kirish",
    change_pw: "🔐 Parolni yangilash",
    cancel: "❌ Bekor qilish",
    error: "⚠️ Xatolik yuz berdi. Keyinroq urinib ko'ring.",
  },
  ru: {
    welcome: "👋 Добро пожаловать!\n\nДля входа в систему Intizom поделитесь номером телефона:",
    lang_prompt: "🌐 Выберите язык",
    share_phone: "📱 Поделиться номером",
    not_found: "❌ Ваш номер не найден.\n\nОбратитесь в отдел кадров.",
    blocked: "🚫 Ваш аккаунт заблокирован.\n\nСвяжитесь с администратором.",
    success: "✅ Здравствуйте, {name}!\n{title}\n\n🔓 <b>Данные для входа:</b>\n\n📱 Логин: <code>{phone}</code>\n🔑 Пароль: <code>{password}</code>\n\n👇 Откройте сайт или перейдите: <a href=\"{url}\">{url}</a>\n\n<i>⚠️ Сохраните пароль или измените его в Настройках после входа.</i>",
    open_app: "🌐 Открыть сайт",
    change_pw: "🔐 Изменить пароль",
    cancel: "❌ Отменить",
    error: "⚠️ Ошибка. Попробуйте позже.",
  },
  en: {
    welcome: "👋 Welcome!\n\nTo sign in to Intizom, please share your phone number:",
    lang_prompt: "🌐 Select language",
    share_phone: "📱 Share phone number",
    not_found: "❌ Your number is not in the whitelist.\n\nPlease contact HR department.",
    blocked: "🚫 Your account is blocked.\n\nContact administrator.",
    success: "✅ Hello, {name}!\n{title}\n\n🔓 <b>Your login credentials:</b>\n\n📱 Login: <code>{phone}</code>\n🔑 Password: <code>{password}</code>\n\n👇 Open website: <a href=\"{url}\">{url}</a>\n\n<i>⚠️ Save the password or change it in Settings after login.</i>",
    open_app: "🌐 Open website",
    change_pw: "🔐 Change password",
    cancel: "❌ Cancel",
    error: "⚠️ Error. Try again later.",
  },
};

function normalizePhone(raw) {
  if (!raw) return "";
  let p = String(raw).replace(/[^\d]/g, "");
  if (p.startsWith("998") && p.length === 12) return "+" + p;
  if (p.length === 9) return "+998" + p;
  if (p.length === 12) return "+" + p;
  return "+" + p;
}

async function setLang(chatId, lang) {
  await db.ref(`tg_sessions/${chatId}/lang`).set(lang);
}

async function getLang(chatId) {
  const snap = await db.ref(`tg_sessions/${chatId}/lang`).once("value");
  return snap.val() || "uz";
}

async function lookupWhitelist(phone) {
  const snap = await db.ref("whitelist").once("value");
  const all = snap.val() || {};
  for (const key in all) {
    const rec = all[key];
    if (!rec || !rec.phone) continue;
    if (normalizePhone(rec.phone) === phone) {
      return { ...rec, key };
    }
  }
  return null;
}

function randomPassword() {
  // Kuchli lekin insonga qulay: 10 belgi, aniq harflar (0/O/l/1 yo'q)
  const letters = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz";
  const digits = "23456789";
  const all = letters + digits;
  const bytes = require("crypto").randomBytes(16);
  let out = "";
  // Kafolat: kamida 2 ta harf va 2 ta raqam (parol talabiga mos)
  out += letters[bytes[0] % letters.length];
  out += letters[bytes[1] % letters.length];
  out += digits[bytes[2] % digits.length];
  out += digits[bytes[3] % digits.length];
  for (let i = 4; i < 10; i++) out += all[bytes[i] % all.length];
  // Shuffle
  return out.split("").sort(() => bytes[15] % 2 ? 1 : -1).join("");
}

async function ensureUser(rec) {
  // rec.key = phone normalized
  const phone = normalizePhone(rec.phone);
  const empKey = String(rec.name || "").replace(/[\u2018\u2019'`]/g, "").replace(/\s+/g, "_");
  const tempPassword = randomPassword();

  // ═══ ACCOUNT LINKING ═══
  // Priority:
  // 1. If whitelist has "linkEmail" field → use that existing account (admin/boss etc.)
  // 2. Otherwise try existing @intizom.uz phone-email
  // 3. Otherwise create new phone-based account
  const preferredEmail = (rec.linkEmail || "").toLowerCase().trim();
  const phoneEmail = phone.replace("+", "").replace(/\D/g, "") + "@intizom.uz";

  let user = null;
  let emailUsed = phoneEmail;

  console.log("[ensureUser] phone:", phone, "preferredEmail:", preferredEmail, "phoneEmail:", phoneEmail);

  // Try linked email first
  if (preferredEmail) {
    try {
      user = await admin.auth().getUserByEmail(preferredEmail);
      emailUsed = preferredEmail;
      console.log("[ensureUser] ✓ Found at preferredEmail, uid:", user.uid);
    } catch (e) {
      console.log("[ensureUser] preferredEmail not found:", e.code);
    }
  }

  // If no linked email, try phone-based email
  if (!user) {
    try {
      user = await admin.auth().getUserByEmail(phoneEmail);
      emailUsed = phoneEmail;

      // Migration: if preferredEmail is set but user was found at phoneEmail,
      // rename the user to preferredEmail (so phone login via getEmailForPhone works)
      if (preferredEmail && preferredEmail !== phoneEmail) {
        try {
          await admin.auth().updateUser(user.uid, { email: preferredEmail, emailVerified: true });
          emailUsed = preferredEmail;
          console.log("[migrate] " + phoneEmail + " → " + preferredEmail);
        } catch (err) {
          console.warn("Email migration failed:", err.message);
        }
      }
    } catch (_) {}
  }

  if (user) {
    // Existing user — set temp password
    await admin.auth().updateUser(user.uid, { password: tempPassword });
    // Update/sync metadata (non-destructive)
    await db.ref(`users/${user.uid}`).update({
      name: rec.name,
      empKey,
      phone,
      title: rec.title || "",
      linkedPhone: phone,
      lastLogin: Date.now(),
    });
    // Preserve role — NEVER downgrade admin via Telegram login
    const existingRole = (await db.ref(`user_roles/${user.uid}`).once("value")).val();
    if (!existingRole) {
      await db.ref(`user_roles/${user.uid}`).set(rec.role || "employee");
    }
  } else {
    // Create new user AT linkEmail if specified (so phone login with getEmailForPhone works)
    const createEmail = preferredEmail || phoneEmail;
    emailUsed = createEmail;
    user = await admin.auth().createUser({
      email: createEmail,
      password: tempPassword,
      emailVerified: true,
      displayName: rec.name,
      disabled: false,
    });
    await db.ref(`user_roles/${user.uid}`).set(rec.role || "employee");
    await db.ref(`users/${user.uid}`).set({
      name: rec.name,
      empKey,
      phone,
      role: rec.role || "employee",
      title: rec.title || "",
      createdAt: Date.now(),
      lastLogin: Date.now(),
    });
  }
  return { uid: user.uid, email: emailUsed, tempPassword };
}

exports.telegramLoginBot = functions
  .runWith({ timeoutSeconds: 30, memory: "256MB" })
  .https.onRequest(async (req, res) => {
    try {
      if (req.method !== "POST") {
        return res.status(200).send("OK");
      }
      // Webhook secret check (prevents random POSTs to this function)
      try {
        const secretSnap = await db.ref("config/login_bot/webhook_secret").once("value");
        const expected = secretSnap.val();
        if (expected) {
          const got = req.headers["x-telegram-bot-api-secret-token"] || "";
          if (got !== expected) {
            console.warn("[loginBot] Secret mismatch");
            return res.status(403).send("Forbidden");
          }
        }
      } catch (_) {}
      const update = req.body || {};
      const msg = update.message || update.callback_query?.message;
      if (!msg) return res.status(200).send("OK");

      const chatId = msg.chat?.id || update.callback_query?.from?.id;
      if (!chatId) return res.status(200).send("OK");

      // ——— /start ———
      if (update.message?.text === "/start" || update.message?.text?.startsWith("/start ")) {
        await tgApiLogin("sendMessage", {
          chat_id: chatId,
          text: TG_T.uz.lang_prompt + "\n" + TG_T.ru.lang_prompt + "\n" + TG_T.en.lang_prompt,
          reply_markup: {
            inline_keyboard: [
              [{ text: "🇺🇿 O'zbekcha", callback_data: "lang:uz" }],
              [{ text: "🇷🇺 Русский", callback_data: "lang:ru" }],
              [{ text: "🇬🇧 English", callback_data: "lang:en" }],
            ],
          },
        });
        return res.status(200).send("OK");
      }

      // ——— Language callback ———
      if (update.callback_query?.data?.startsWith("lang:")) {
        const lang = update.callback_query.data.split(":")[1];
        await setLang(chatId, lang);
        const t = TG_T[lang] || TG_T.uz;
        await tgApiLogin("answerCallbackQuery", { callback_query_id: update.callback_query.id });
        await tgApiLogin("sendMessage", {
          chat_id: chatId,
          text: t.welcome,
          reply_markup: {
            keyboard: [[{ text: t.share_phone, request_contact: true }]],
            resize_keyboard: true,
            one_time_keyboard: true,
          },
        });
        return res.status(200).send("OK");
      }

      // ——— Contact shared ———
      if (update.message?.contact) {
        const contact = update.message.contact;
        const lang = await getLang(chatId);
        const t = TG_T[lang] || TG_T.uz;

        // Security: verify phone belongs to the sender
        if (contact.user_id && contact.user_id !== update.message.from.id) {
          await tgApiLogin("sendMessage", { chat_id: chatId, text: "⚠️ Faqat o'z raqamingizni ulashing!" });
          return res.status(200).send("OK");
        }

        const phone = normalizePhone(contact.phone_number);
        const rec = await lookupWhitelist(phone);

        if (!rec) {
          await tgApiLogin("sendMessage", { chat_id: chatId, text: t.not_found, reply_markup: { remove_keyboard: true } });
          return res.status(200).send("OK");
        }
        if (rec.active === false) {
          await tgApiLogin("sendMessage", { chat_id: chatId, text: t.blocked, reply_markup: { remove_keyboard: true } });
          return res.status(200).send("OK");
        }

        // Create/get user + generate fresh password
        const { uid, email, tempPassword } = await ensureUser({ ...rec, phone });

        const appUrl = `https://intizominvest.vercel.app/`;
        const roleLabel = rec.title || (rec.role === "admin" ? "Kadrlar bo'limi" : rec.role === "boss" ? "Rahbar" : rec.role === "observer" ? "Kuzatuvchi" : "Xodim");

        const successMsg = t.success
          .replace("{name}", rec.name)
          .replace("{title}", roleLabel)
          .replace("{phone}", phone)
          .replace(/\{password\}/g, tempPassword)
          .replace(/\{url\}/g, appUrl);

        await tgApiLogin("sendMessage", {
          chat_id: chatId,
          text: successMsg,
          parse_mode: "HTML",
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: [[{ text: t.open_app, url: appUrl }]],
            remove_keyboard: true,
          },
        });
        return res.status(200).send("OK");
      }

      return res.status(200).send("OK");
    } catch (e) {
      console.error("telegramLoginBot error:", e);
      return res.status(200).send("OK");
    }
  });

/**
 * Web app uchun: tg_logins/{id} ni olib, custom token qaytarish
 * Saytdan Firebase signInWithCustomToken chaqirish
 */
exports.claimTelegramLogin = functions.https.onRequest(async (req, res) => {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.some(o => origin === o)) {
    res.set("Access-Control-Allow-Origin", origin);
  }
  res.set("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Vary", "Origin");
  if (req.method === "OPTIONS") return res.status(204).send("");

  try {
    const { loginId } = req.body || {};
    if (!loginId || typeof loginId !== "string" || loginId.length > 100) {
      return res.status(400).json({ error: "Invalid loginId" });
    }
    const snap = await db.ref(`tg_logins/${loginId}`).once("value");
    const rec = snap.val();
    if (!rec) return res.status(404).json({ error: "Not found" });
    if (rec.used) return res.status(410).json({ error: "Already used" });
    if (Date.now() > rec.expiresAt) return res.status(410).json({ error: "Expired" });

    // Mark as used (one-time)
    await db.ref(`tg_logins/${loginId}`).update({ used: true, usedAt: Date.now() });

    return res.json({
      // Custom token (preferred — doesn't reset password, doesn't kick out other sessions)
      token: rec.token,
      // Legacy email+password fallback (still supported for old records)
      email: rec.email,
      tempPassword: rec.tempPassword,
      name: rec.name,
      phone: rec.phone
    });
  } catch (e) {
    console.error("claimTelegramLogin error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * Phone → Email lookup (oldin login qilishda)
 * POST {phone: "+998XXXXXXXXX"} → {email: "user@domain"}
 * No auth required (just a lookup — doesn't leak PII beyond what's already public)
 */
exports.getEmailForPhone = functions.https.onRequest(async (req, res) => {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.some(o => origin === o)) {
    res.set("Access-Control-Allow-Origin", origin);
  }
  res.set("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Vary", "Origin");
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).json({error:"POST only"});
  try {
    const { phone } = req.body || {};
    if (!phone || typeof phone !== "string" || phone.length > 20) {
      return res.status(400).json({error:"Invalid phone"});
    }
    // Normalize phone
    let p = String(phone).replace(/[^\d]/g, "");
    if (p.length === 9) p = "998" + p;
    const normalized = "+" + p;
    const keyId = p; // whitelist key is digits-only

    // Look up whitelist
    const snap = await db.ref("whitelist/"+keyId).once("value");
    const rec = snap.val();
    if (!rec) return res.status(404).json({error:"Not registered"});
    if (rec.active === false) return res.status(403).json({error:"Account disabled"});

    // If linkEmail exists, use it (original email account)
    // Otherwise use the generated phone-based email
    const email = rec.linkEmail || (p + "@intizom.uz");
    return res.json({ email });
  } catch (e) {
    console.error("getEmailForPhone error:", e);
    return res.status(500).json({error:"Server error"});
  }
});

/**
 * Parol o'rnatish — faqat autentifikatsiya qilingan foydalanuvchi o'zi uchun
 * Foydalanuvchi Telegram orqali kirgandan keyin ushbu HTTPS funksiyani chaqiradi
 */
exports.setUserPassword = functions.https.onRequest(async (req, res) => {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.some(o => origin === o)) {
    res.set("Access-Control-Allow-Origin", origin);
  }
  res.set("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type,Authorization");
  res.set("Vary", "Origin");
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: "Missing auth" });

    const decoded = await admin.auth().verifyIdToken(idToken);
    const { password } = req.body || {};

    if (!password || typeof password !== "string") {
      return res.status(400).json({ error: "Password required" });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "Parol kamida 8 belgidan iborat bo'lishi kerak" });
    }
    // Check complexity: at least 1 letter and 1 digit
    if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
      return res.status(400).json({ error: "Parol harf va raqamdan iborat bo'lishi kerak" });
    }
    // Check against top common passwords
    const COMMON = new Set(["password","12345678","qwerty123","admin123","letmein123","welcome1","123456789","password1","qwertyui","abc12345"]);
    if (COMMON.has(password.toLowerCase())) {
      return res.status(400).json({ error: "Bu parol juda keng tarqalgan — boshqasini tanlang" });
    }
    if (password.length > 128) {
      return res.status(400).json({ error: "Parol juda uzun" });
    }

    await admin.auth().updateUser(decoded.uid, { password });
    return res.json({ success: true });
  } catch (e) {
    console.error("setUserPassword error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});
// One-shot HTTP function to fix Lazizbek's account
exports.fixLazizbek = functions.https.onRequest(async (req, res) => {
  try {
    const phoneEmail = "998913333563@intizom.uz";
    const linkEmail = "lazizbek.saidov@boshqarma.uz";
    const newPassword = "lazizbek123";
    const result = { phoneEmail: null, linkEmail: null, action: null };

    // Check phoneEmail
    try {
      const u = await admin.auth().getUserByEmail(phoneEmail);
      result.phoneEmail = { uid: u.uid, exists: true };
    } catch(_) { result.phoneEmail = { exists: false }; }

    // Check linkEmail
    try {
      const u = await admin.auth().getUserByEmail(linkEmail);
      result.linkEmail = { uid: u.uid, exists: true };
    } catch(_) { result.linkEmail = { exists: false }; }

    // Action: ensure linkEmail account exists with known password
    if (result.linkEmail.exists) {
      await admin.auth().updateUser(result.linkEmail.uid, { password: newPassword });
      result.action = "updated_linkEmail_password";
    } else if (result.phoneEmail.exists) {
      await admin.auth().updateUser(result.phoneEmail.uid, { email: linkEmail, emailVerified: true, password: newPassword });
      result.action = "migrated_phoneEmail_to_linkEmail";
    } else {
      const u = await admin.auth().createUser({
        email: linkEmail,
        password: newPassword,
        emailVerified: true,
        displayName: "Saidov Lazizbek"
      });
      result.action = "created_new";
      result.newUid = u.uid;
    }
    result.password = newPassword;
    res.json(result);
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

// One-shot: delete orphan phoneEmail account for Lazizbek
exports.cleanupOrphan = functions.https.onRequest(async (req, res) => {
  try {
    const phoneEmail = "998913333563@intizom.uz";
    try {
      const u = await admin.auth().getUserByEmail(phoneEmail);
      await admin.auth().deleteUser(u.uid);
      res.json({deleted: u.uid, email: phoneEmail});
    } catch(e) {
      res.json({notFound: phoneEmail});
    }
  } catch(e) {
    res.status(500).json({error: e.message});
  }
});

// BULK: har bir whitelist xodimiga sodda parol set qiladi va ro'yxat qaytaradi
exports.bulkSetPasswords = functions.https.onRequest(async (req, res) => {
  try {
    const wlSnap = await db.ref("whitelist").once("value");
    const wl = wlSnap.val() || {};
    const out = [];

    for (const key of Object.keys(wl)) {
      const rec = wl[key];
      if (!rec || !rec.phone || rec.active === false) continue;
      // Telefonning oxirgi 4 ta raqami bo'yicha sodda parol
      const digits = rec.phone.replace(/\D/g, "");
      const last4 = digits.slice(-4);
      // Familiya to'liq (qisqartirmaydi) + oxirgi 4 raqam
      const firstPart = (rec.name || "").split(" ")[0]
        .toLowerCase()
        .replace(/[\u2018\u2019'`]/g, "")
        .replace(/[^a-z]/g, "") || "user";
      const password = firstPart + last4;  // masalan: ermamatov8697

      // Admin/boss/observer-ni skip qilish (ularda kuchli parol bor)
      if (rec.role === "admin" || rec.role === "boss" || rec.role === "observer") {
        continue;
      }

      const preferredEmail = (rec.linkEmail || "").toLowerCase().trim();
      const phoneEmail = digits + "@intizom.uz";
      const empKey = (rec.name || "").replace(/[\u2018\u2019'`]/g, "").replace(/\s+/g, "_");

      let user = null;
      if (preferredEmail) {
        try { user = await admin.auth().getUserByEmail(preferredEmail); } catch(_) {}
      }
      if (!user) {
        try { user = await admin.auth().getUserByEmail(phoneEmail); } catch(_) {}
      }

      if (user) {
        await admin.auth().updateUser(user.uid, { password });
        // Agar email noto'g'ri (phoneEmail bor, linkEmail bo'lishi kerak), yangilash
        if (preferredEmail && user.email !== preferredEmail) {
          try {
            await admin.auth().updateUser(user.uid, { email: preferredEmail, emailVerified: true });
          } catch(_) {}
        }
      } else {
        // Yangi akkaunt yaratish
        const createEmail = preferredEmail || phoneEmail;
        user = await admin.auth().createUser({
          email: createEmail,
          password,
          emailVerified: true,
          displayName: rec.name,
        });
        await db.ref(`user_roles/${user.uid}`).set(rec.role || "employee");
      }

      // users/{uid} ga sinxron
      await db.ref(`users/${user.uid}`).update({
        name: rec.name,
        empKey,
        phone: rec.phone,
        title: rec.title || "",
      });

      out.push({
        name: rec.name,
        phone: rec.phone,
        password,
        role: rec.role || "employee",
        uid: user.uid,
      });
    }

    out.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ count: out.length, list: out });
  } catch (e) {
    console.error("bulkSetPasswords error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Kuchli parollar Admin/Boss/Observer uchun — taxmin qilib bo'lmaydi
exports.setStrongPasswords = functions.https.onRequest(async (req, res) => {
  try {
    const emails = [
      "kadr@boshqarma.uz",
      "ravshan.azimov@boshqarma.uz",
      "elbek.gafforov@boshqarma.uz"
    ];
    const crypto = require("crypto");
    const out = [];
    for (const email of emails) {
      try {
        const user = await admin.auth().getUserByEmail(email);
        // 16 belgi, harf+raqam+simvol aralash
        const charset = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%&*";
        const bytes = crypto.randomBytes(16);
        let pw = "";
        for (let i = 0; i < 16; i++) pw += charset[bytes[i] % charset.length];
        await admin.auth().updateUser(user.uid, { password: pw });
        out.push({ email, password: pw });
      } catch (e) {
        out.push({ email, error: e.message });
      }
    }
    res.json({ passwords: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Faqat 2 ta yangi xodim uchun sodda parol
exports.fixTwoEmployees = functions.https.onRequest(async (req, res) => {
  const list = [
    { phone: "+998973690008", name: "Ne'matov Shahzodbek", password: "nematov0008" },
    { phone: "+998993617764", name: "Muhammadov Jaloliddin", password: "muhammad7764" },
  ];
  const out = [];
  for (const item of list) {
    const phoneDigits = item.phone.replace(/\D/g, "");
    const phoneEmail = phoneDigits + "@intizom.uz";
    try {
      let user;
      try {
        user = await admin.auth().getUserByEmail(phoneEmail);
        await admin.auth().updateUser(user.uid, { password: item.password });
      } catch (_) {
        user = await admin.auth().createUser({
          email: phoneEmail,
          password: item.password,
          emailVerified: true,
          displayName: item.name,
        });
        await db.ref(`user_roles/${user.uid}`).set("employee");
      }
      const empKey = item.name.replace(/[\u2018\u2019'`]/g, "").replace(/\s+/g, "_");
      await db.ref(`users/${user.uid}`).update({
        name: item.name, empKey, phone: item.phone, role: "employee", title: "Xodim"
      });
      out.push({ name: item.name, phone: item.phone, password: item.password, uid: user.uid });
    } catch (e) {
      out.push({ name: item.name, error: e.message });
    }
  }
  res.json(out);
});

// Delete old placeholder accounts for Ne'matov and Muhammadov
exports.deleteOldPlaceholders = functions.https.onRequest(async (req, res) => {
  const oldEmails = ["998000000023@intizom.uz", "998000000024@intizom.uz"];
  const out = [];
  for (const email of oldEmails) {
    try {
      const u = await admin.auth().getUserByEmail(email);
      await admin.auth().deleteUser(u.uid);
      out.push({ email, deleted: u.uid });
    } catch (e) {
      out.push({ email, notFound: true });
    }
  }
  res.json(out);
});

// Saidov Lazizbek \u2014 admin, lekin sodda parol xohlayapti
exports.fixSaidov = functions.https.onRequest(async (req, res) => {
  try {
    const user = await admin.auth().getUserByEmail("lazizbek.saidov@boshqarma.uz");
    const password = "saidov3563";
    await admin.auth().updateUser(user.uid, { password });
    res.json({ email: "lazizbek.saidov@boshqarma.uz", password });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Kadr admin — reset password to known value
exports.fixKadr = functions.https.onRequest(async (req, res) => {
  try {
    const user = await admin.auth().getUserByEmail("kadr@boshqarma.uz");
    const password = "kadr2026";
    await admin.auth().updateUser(user.uid, { password });
    res.json({ email: "kadr@boshqarma.uz", password, uid: user.uid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══ TELEGRAM MINI APP AUTO-LOGIN ═══
// Validates Telegram WebApp initData signature, finds linked user, returns Firebase custom token.
// Called by the web app when opened inside Telegram Mini App context.
exports.telegramMiniAppAuth = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { initData } = req.body || {};
    if (!initData || typeof initData !== "string") {
      return res.status(400).json({ error: "initData required" });
    }
    // Verify Telegram HMAC signature
    const crypto = require("crypto");
    const botToken = await getBotToken();
    if (!botToken) return res.status(500).json({ error: "Bot token not configured" });

    const urlParams = new URLSearchParams(initData);
    const receivedHash = urlParams.get("hash");
    if (!receivedHash) return res.status(401).json({ error: "hash missing" });
    urlParams.delete("hash");
    // Sort params alphabetically, join as key=value\n
    const dataCheckString = Array.from(urlParams.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    // Telegram spec: secret_key = HMAC_SHA256(bot_token, key="WebAppData")
    const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
    const expectedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
    if (expectedHash !== receivedHash) {
      console.warn("[tgAuth] HMAC mismatch");
      return res.status(401).json({ error: "Invalid signature" });
    }
    // Check auth_date not too old (1 hour max)
    const authDate = parseInt(urlParams.get("auth_date") || "0", 10);
    if (Date.now() / 1000 - authDate > 3600) {
      return res.status(401).json({ error: "initData expired" });
    }
    // Extract Telegram user
    const tgUserJson = urlParams.get("user");
    if (!tgUserJson) return res.status(400).json({ error: "user missing" });
    const tgUser = JSON.parse(tgUserJson);
    const chatId = String(tgUser.id);
    // Look up linked phone
    const phoneSnap = await db.ref(`tg_sessions/${chatId}/linkedPhone`).once("value");
    const phone = phoneSnap.val();
    if (!phone) return res.status(403).json({ error: "Not linked — use /login in bot" });
    // Look up whitelist entry
    const rec = await lookupWhitelist(phone);
    if (!rec || rec.active === false) return res.status(403).json({ error: "Not authorized" });
    // Find Firebase user (via preferredEmail or phoneEmail)
    const preferredEmail = (rec.linkEmail || "").toLowerCase().trim();
    const phoneEmail = phone.replace("+", "").replace(/\D/g, "") + "@intizom.uz";
    let user = null;
    if (preferredEmail) { try { user = await admin.auth().getUserByEmail(preferredEmail); } catch (_) {} }
    if (!user) { try { user = await admin.auth().getUserByEmail(phoneEmail); } catch (_) {} }
    if (!user) return res.status(404).json({ error: "User not created — use /login first" });
    // Generate custom token
    const customToken = await admin.auth().createCustomToken(user.uid);
    return res.json({ token: customToken, uid: user.uid, name: rec.name, phone });
  } catch (e) {
    console.error("telegramMiniAppAuth error:", e);
    return res.status(500).json({ error: e.message });
  }
});

// ═══ BACKFILL: Process existing checkins into attendance for a given date ═══
// One-shot recovery — call GET /backfillAttendance?date=YYYY-MM-DD
exports.backfillAttendance = functions.https.onRequest(async (req, res) => {
  try {
    const dateKey = req.query.date || new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tashkent" });
    const checkinsSnap = await db.ref(`checkins/${dateKey}`).once("value");
    const checkins = checkinsSnap.val() || {};
    let processed = 0;
    const errors = [];
    // Build COMPLETE fresh attendance object from checkins (replace, don't append)
    for (const empKey of Object.keys(checkins)) {
      const sessions = checkins[empKey];
      if (!sessions) continue;
      try {
        const noteParts = [];
        let morningLate = 0, afternoonLate = 0;
        let hasAnyWorkStatus = false;
        for (const session of ["morning", "afternoon"]) {
          const checkin = sessions[session];
          if (!checkin) continue;
          const timeStr = checkin.time || "";
          let lateMinutes = 0;
          const [hh, mm] = timeStr.split(":").map(Number);
          if (!isNaN(hh) && !isNaN(mm)) {
            const totalMin = hh * 60 + mm;
            const deadlineMin = session === "morning" ? 9 * 60 + 10 : 14 * 60 + 10;
            if (totalMin > deadlineMin) lateMinutes = totalMin - deadlineMin;
          }
          if (session === "morning") morningLate = lateMinutes;
          else afternoonLate = lateMinutes;
          hasAnyWorkStatus = true;
          const notePrefix = checkin.empNote ? " — " + checkin.empNote : "";
          const label = session === "morning"
            ? (lateMinutes === 0 ? "Ertalab selfie (09:10 gacha): " : "Selfie 09:10 dan keyin: ")
            : (lateMinutes === 0 ? "Tushlikdan keyingi selfie (14:10 gacha): " : "Selfie 14:10 dan keyin: ");
          noteParts.push(label + timeStr + notePrefix);
        }
        if (!hasAnyWorkStatus) continue;
        // Preserve existing non-selfie note (manually-written admin notes before/after selfie lines)
        const existingSnap = await db.ref(`attendance/${dateKey}/${empKey}`).once("value");
        const existing = existingSnap.val() || {};
        // Filter existing note — keep only non-auto-generated parts (admin's manual notes)
        const existingNote = existing.note || "";
        const manualParts = existingNote.split(" | ").filter(p =>
          p && !p.match(/^(Ertalab selfie|Selfie 09:10|Tushlikdan keyingi selfie|Selfie 14:10)/)
        );
        const combinedNote = [...manualParts, ...noteParts].filter(Boolean).join(" | ");
        const totalLate = morningLate + afternoonLate;
        await db.ref(`attendance/${dateKey}/${empKey}`).update({
          status: totalLate > 0 ? "late" : "present",
          morning: morningLate,
          afternoon: afternoonLate,
          note: combinedNote
        });
        processed++;
      } catch (e) {
        errors.push({ empKey, error: e.message });
      }
    }
    res.json({ ok: true, dateKey, processed, errors });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
//  PUSH NOTIFICATIONS — FCM (Firebase Cloud Messaging)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Send an FCM push notification to ALL devices of ALL users (or a specific UID).
 * Tokens are stored in /fcm_tokens/{uid}/{tokenId} by the client on login.
 *
 * @param {object} payload - { title, body, data? }
 * @param {string|string[]} [uids] - specific user UID(s); if omitted, broadcasts to all.
 */
async function sendPushToUsers(payload, uids) {
  const tokens = [];
  if (uids) {
    const arr = Array.isArray(uids) ? uids : [uids];
    for (const uid of arr) {
      const snap = await db.ref("fcm_tokens/" + uid).once("value");
      const byTok = snap.val() || {};
      Object.values(byTok).forEach(t => { if (t && t.token) tokens.push(t.token); });
    }
  } else {
    const snap = await db.ref("fcm_tokens").once("value");
    const all = snap.val() || {};
    Object.values(all).forEach(userTokens => {
      Object.values(userTokens || {}).forEach(t => { if (t && t.token) tokens.push(t.token); });
    });
  }
  if (!tokens.length) return { sent: 0, reason: "no tokens" };
  // Dedupe
  const unique = Array.from(new Set(tokens));
  const msg = {
    notification: { title: payload.title, body: payload.body },
    data: Object.fromEntries(Object.entries(payload.data || {}).map(([k, v]) => [k, String(v)])),
    tokens: unique,
  };
  const resp = await admin.messaging().sendEachForMulticast(msg);
  // Clean up invalid tokens
  if (resp && resp.responses) {
    const staleTokens = [];
    resp.responses.forEach((r, i) => {
      if (!r.success && r.error) {
        const code = r.error.code || "";
        if (code.includes("registration-token-not-registered") || code.includes("invalid-argument")) {
          staleTokens.push(unique[i]);
        }
      }
    });
    if (staleTokens.length) {
      // Remove from DB — iterate all users, remove matching tokens
      const allSnap = await db.ref("fcm_tokens").once("value");
      const all = allSnap.val() || {};
      for (const uid of Object.keys(all)) {
        for (const tokId of Object.keys(all[uid] || {})) {
          if (staleTokens.includes(all[uid][tokId].token)) {
            await db.ref(`fcm_tokens/${uid}/${tokId}`).remove().catch(() => {});
          }
        }
      }
    }
  }
  return { sent: resp.successCount || 0, failed: resp.failureCount || 0, total: unique.length };
}

/**
 * HTTP endpoint to send a push — admin-triggered from web UI.
 * POST {title, body, uids?, data?}
 */
exports.sendPush = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { title, body, uids, data } = req.body || {};
    if (!title || !body) return res.status(400).json({ error: "title and body required" });
    const result = await sendPushToUsers({ title, body, data }, uids);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══ PUSH NOTIFICATIONS ═══
// User-facing reminders sent to FCM tokens (mobile devices via APK).
// Different from Telegram group reports — these go to individual user phones.
//
// Re-enabled per user request (2026-04-26):
// • pushMorningReminder — 08:45 weekdays (selfie reminder)
// • pushOnAnnouncement — fires when admin creates announcement
// • pushBirthday — 09:00 daily (only fires if today is someone's birthday)

exports.pushOnAnnouncement = functions.database
  .ref("/announcements/{annId}")
  .onCreate(async (snapshot) => {
    const ann = snapshot.val() || {};
    await sendPushToUsers({
      title: "📢 Yangi e'lon",
      body: (ann.title || "") + (ann.body ? " — " + ann.body.substring(0, 100) : ""),
      data: { view: "announcements", annId: snapshot.key },
    });
    return null;
  });

// pushMorningReminder + pushBirthday DELETED 2026-04-27 per user request
// (every-day spam scheduled functions removed; only pushOnAnnouncement kept).
