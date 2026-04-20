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

const EMPLOYEES = [
  "Umrzoqov Bunyod","Ermamatov Xurshid",
  "Akbarova Moxlaroyim","Faxriddinov Oxunjon",
  "Hamdamov Shuxrat","Nazarov Muzaffar","Nurmamatov Oxunjon",
  "Xolmurodov Dostonjon","Qurbonov Shavkat","Narzullayev Rustam",
  "Islomov G\u2018ulomjon","Ibrohimov Shuhrat","Barnoqulov Shahzod",
  "Axadov Izzatullo","Jo\u2018raqulov Jahongirbek","Jaynakov Temur",
  "Saidov Lazizbek","Pirbayev Berdiyor","Husainova Klara",
  "Ne\u2018matov Shahzodbek","Muhammadov Jaloliddin"
];

const BIRTHDAYS = {
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
  return name.replace(/[\u2018\u2019\u02BC\u0060\u2018\u2019'`]/g, "").replace(/\s+/g, "_").replace(/[.#$/[\]]/g, "_");
}

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
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
  const [attSnap, checkSnap] = await Promise.all([
    db.ref(`attendance/${dateKey}`).once("value"),
    db.ref(`checkins/${dateKey}`).once("value")
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

  EMPLOYEES.forEach(emp => {
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

  const workingTotal = EMPLOYEES.length - sababli.length;
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
  const snap = await db.ref(`attendance/${dateKey}`).once("value");
  const dayData = snap.val() || {};

  const lateList = [];
  EMPLOYEES.forEach(emp => {
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

  const [attSnap, checkSnap] = await Promise.all([
    db.ref("attendance").once("value"),
    db.ref("checkins").once("value")
  ]);
  const allAtt = attSnap.val() || {};
  const allCheckins = checkSnap.val() || {};

  let totalPresent = 0, totalLate = 0, totalAbsent = 0, totalLateMins = 0;
  const empScores = [];

  EMPLOYEES.forEach(emp => {
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
  const avgScore = Math.round(empScores.reduce((s, e) => s + e.score, 0) / Math.max(1, EMPLOYEES.length));
  const months = ["Yanvar","Fevral","Mart","Aprel","May","Iyun","Iyul","Avgust","Sentabr","Oktabr","Noyabr","Dekabr"];

  let text = `📈 <b>Oylik statistika — ${months[mon]} ${yr}</b>\n`;
  text += `━━━━━━━━━━━━━━━━━━\n`;
  text += `📅 O'tgan ish kunlari: <b>${dates.length}</b>\n`;
  text += `👥 Xodimlar: <b>${EMPLOYEES.length}</b>\n`;
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

// ═══ TELEGRAM WEBHOOK ═══
exports.telegramWebhook = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") { res.status(200).send("OK"); return; }
  const message = req.body?.message;
  if (!message?.text) { res.status(200).send("OK"); return; }

  const chatId = message.chat.id;
  const cmd = message.text.trim().split(" ")[0].split("@")[0].toLowerCase();
  const todayKey = fmtDate(new Date());

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

  const isGroup = message.chat.type === "group" || message.chat.type === "supergroup";

  try {
    let reply = "";

    if (!isGroup) {
      // Shaxsiy chat — faqat salomlashish va ma'lumot
      switch (cmd) {
        case "/start":
          reply = "👋 <b>Assalomu alaykum!</b>\n\n"
            + "🏢 Bu bot — Navoiy viloyati Investitsiyalar, sanoat va savdo boshqarmasi "
            + "xodimlarining davomatini kuzatish uchun yaratilgan.\n\n"
            + "📊 Davomat ma'lumotlarini ko'rish uchun botni <b>guruhga</b> qo'shing "
            + "va u yerda quyidagi buyruqlarni ishlating:\n\n"
            + "📊 /davomat — Bugungi davomat\n"
            + "⏰ /kechikkanlar — Kechikkan xodimlar\n"
            + "📈 /statistika — Oylik statistika\n\n"
            + "🌐 <b>Veb tizim:</b>\n"
            + "https://lazizbeksaidov.github.io/davomat-tizimi/";
          break;
        case "/yordam": case "/help":
          reply = "🤖 <b>Xodimlar Monitoring Bot</b>\n\n"
            + "📊 Davomat buyruqlari faqat <b>guruh chatida</b> ishlaydi.\n\n"
            + "🌐 <b>Veb tizim:</b>\n"
            + "https://lazizbeksaidov.github.io/davomat-tizimi/";
          break;
        default:
          reply = "ℹ️ Bu bot faqat guruh chatida davomat ma'lumotlarini ko'rsatadi.\n"
            + "Batafsil: /start";
          break;
      }
    } else {
      // Guruh chat — davomat buyruqlari ishlaydi
      switch (cmd) {
        case "/davomat": case "/start":
          reply = await buildDavomatReport(todayKey); break;
        case "/kechikkanlar":
          reply = await buildKechikkanlarReport(todayKey); break;
        case "/statistika":
          reply = await buildStatistikaReport(); break;
        case "/yordam": case "/help":
          reply = "🤖 <b>Xodimlar Monitoring Bot</b>\n\n"
            + "📊 /davomat — Bugungi davomat\n"
            + "⏰ /kechikkanlar — Kechikkan xodimlar\n"
            + "📈 /statistika — Oylik statistika\n"
            + "❓ /yordam — Yordam\n\n"
            + "📍 Navoiy viloyati Investitsiyalar,\nsanoat va savdo boshqarmasi";
          break;
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
    try {
      const timeStr2 = checkin.time || "";
      const [hh, mm] = timeStr2.split(":").map(Number);
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

// ═══ TUG'ILGAN KUN — 08:00 ═══
exports.birthdayNotify = functions.pubsub
  .schedule("0 8 * * *").timeZone("Asia/Tashkent")
  .onRun(async () => {
    const chatId = await getChatId();
    if (!chatId) return null;
    const now = new Date();
    const day = now.getDate(), month = now.getMonth() + 1;
    const list = [];
    Object.entries(BIRTHDAYS).forEach(([name, ds]) => {
      const p = ds.split(".");
      if (parseInt(p[0]) === day && parseInt(p[1]) === month)
        list.push({ name, age: now.getFullYear() - parseInt(p[2]) });
    });
    if (list.length === 0) return null;
    let text = "🎂🎉 <b>Bugun tug'ilgan kun!</b>\n\n";
    list.forEach(b => { text += `🎈 <b>${b.name}</b> — ${b.age} yoshga to'ldi!\n`; });
    text += "\n🥳 Tabriklaymiz! Sog'lik, baxt va omad tilaymiz!";
    await sendMessage(chatId, text);
    return null;
  });

// ═══ ERTALABKI SELFIE — 09:20 Dush-Juma ═══
exports.morningSelfieCheck = functions.pubsub
  .schedule("20 9 * * 1-5").timeZone("Asia/Tashkent")
  .onRun(async () => {
    const chatId = await getChatId();
    if (!chatId) return null;
    const now = new Date();
    const todayKey = fmtDate(now);
    const d = todayKey.split("-");
    const dateObj = new Date(parseInt(d[0]), parseInt(d[1])-1, parseInt(d[2]));
    const dayName = DAYS_UZ[dateObj.getDay()];
    const dateDisp = `${d[2]}.${d[1]}.${d[0]}`;

    const [attSnap, checkSnap] = await Promise.all([
      db.ref(`attendance/${todayKey}`).once("value"),
      db.ref(`checkins/${todayKey}`).once("value")
    ]);
    const attData = attSnap.val() || {};
    const checkins = checkSnap.val() || {};

    const kelganlar = [];
    const sababli = [];
    const kelmagan = [];

    EMPLOYEES.forEach(emp => {
      const key = safeKey(emp);
      const att = attData[key];
      const check = checkins[key];
      const status = att?.status;

      if (status && NON_WORKING.includes(status)) {
        sababli.push({ name: emp, icon: STATUS_ICONS[status], label: STATUS_LABELS[status] });
        return;
      }
      if (check && check.morning) {
        const lateMin = att?.morning || 0;
        kelganlar.push({ name: emp, lateMin });
        return;
      }
      if (status === "present" || status === "late") {
        kelganlar.push({ name: emp, lateMin: att?.morning || 0 });
        return;
      }
      kelmagan.push(emp);
    });

    const workingTotal = EMPLOYEES.length - sababli.length;
    const pct = workingTotal > 0 ? Math.round(kelganlar.length / workingTotal * 100) : 0;

    let text = `📋 <b>ERTALABKI DAVOMAT</b>\n`;
    text += `📅 ${dateDisp} | ${dayName} | 09:20\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

    text += `✅ <b>Kelganlar (${kelganlar.length}):</b>\n`;
    kelganlar.forEach((e, i) => {
      let line = `  ${i+1}. ${e.name}`;
      if (e.lateMin > 0) line += ` ⏰ (${fmtMins(e.lateMin)} kechikdi)`;
      text += line + "\n";
    });

    if (sababli.length > 0) {
      text += `\n📋 <b>Sababli (${sababli.length}):</b>\n`;
      sababli.forEach((e, i) => { text += `  ${i+1}. ${e.name} (${e.icon} ${e.label})\n`; });
    }

    if (kelmagan.length > 0) {
      text += `\n❌ <b>Kelmagan / Selfie qilmagan (${kelmagan.length}):</b>\n`;
      kelmagan.forEach((e, i) => { text += `  ${i+1}. ${e}\n`; });
    }

    text += `\n━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `📊 Davomat: ${kelganlar.length}/${workingTotal} (${pct}%)`;

    await sendMessage(chatId, text);
    return null;
  });

// ═══ TUSHLIK SELFIE — 14:20 Dush-Juma ═══
exports.afternoonSelfieCheck = functions.pubsub
  .schedule("20 14 * * 1-5").timeZone("Asia/Tashkent")
  .onRun(async () => {
    const chatId = await getChatId();
    if (!chatId) return null;
    const now = new Date();
    const todayKey = fmtDate(now);
    const d = todayKey.split("-");
    const dateObj = new Date(parseInt(d[0]), parseInt(d[1])-1, parseInt(d[2]));
    const dayName = DAYS_UZ[dateObj.getDay()];
    const dateDisp = `${d[2]}.${d[1]}.${d[0]}`;

    const [attSnap, checkSnap] = await Promise.all([
      db.ref(`attendance/${todayKey}`).once("value"),
      db.ref(`checkins/${todayKey}`).once("value")
    ]);
    const attData = attSnap.val() || {};
    const checkins = checkSnap.val() || {};

    const kelganlar = [];
    const sababli = [];
    const kelmagan = [];

    EMPLOYEES.forEach(emp => {
      const key = safeKey(emp);
      const att = attData[key];
      const check = checkins[key];
      const status = att?.status;

      if (status && NON_WORKING.includes(status)) {
        sababli.push({ name: emp, icon: STATUS_ICONS[status], label: STATUS_LABELS[status] });
        return;
      }
      if (check && check.afternoon) {
        const lateMin = att?.afternoon || 0;
        kelganlar.push({ name: emp, lateMin });
        return;
      }
      if (status === "present" || status === "late") {
        kelganlar.push({ name: emp, lateMin: att?.afternoon || 0 });
        return;
      }
      kelmagan.push(emp);
    });

    const workingTotal = EMPLOYEES.length - sababli.length;
    const pct = workingTotal > 0 ? Math.round(kelganlar.length / workingTotal * 100) : 0;

    let text = `📋 <b>TUSHLIK DAVOMAT</b>\n`;
    text += `📅 ${dateDisp} | ${dayName} | 14:20\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

    text += `✅ <b>Kelganlar (${kelganlar.length}):</b>\n`;
    kelganlar.forEach((e, i) => {
      let line = `  ${i+1}. ${e.name}`;
      if (e.lateMin > 0) line += ` ⏰ (${fmtMins(e.lateMin)} kechikdi)`;
      text += line + "\n";
    });

    if (sababli.length > 0) {
      text += `\n📋 <b>Sababli (${sababli.length}):</b>\n`;
      sababli.forEach((e, i) => { text += `  ${i+1}. ${e.name} (${e.icon} ${e.label})\n`; });
    }

    if (kelmagan.length > 0) {
      text += `\n❌ <b>Kelmagan / Selfie qilmagan (${kelmagan.length}):</b>\n`;
      kelmagan.forEach((e, i) => { text += `  ${i+1}. ${e}\n`; });
    }

    text += `\n━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `📊 Davomat: ${kelganlar.length}/${workingTotal} (${pct}%)`;

    await sendMessage(chatId, text);
    return null;
  });

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
    // Hardcoded admin/boss list only applies to pre-approved emails
    if (ADMIN_EMAILS.includes(email) && emailVerified) role = "admin";
    else if (BOSS_EMAILS.includes(email) && emailVerified) role = "boss";
    else if (OBSERVER_EMAILS.includes(email) && emailVerified) role = "observer";
    else if (email.endsWith("@intizom.uz")) {
      // Telegram-created users — role already set by ensureUser during bot flow
      // Just preserve existing
      role = existing || "employee";
    } else {
      // Unknown email — never elevate
      role = "employee";
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

async function tgApi(method, body) {
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
    not_found: "❌ Raqamingiz ro'yxatda topilmadi.\n\nIltimos, kadrlar bo'limiga murojaat qiling.\nRaqam: +998 XX XXX XX XX",
    blocked: "🚫 Akkauntingiz bloklangan.\n\nAdmin bilan bog'laning.",
    success: "✅ Muvaffaqiyatli!\n\nSizning ismingiz: {name}\nLavozim: {title}\n\n👇 Quyidagi havolani bosib, ilovaga kiring:",
    open_app: "🔓 Ilovaga kirish",
    cancel: "❌ Bekor qilish",
    error: "⚠️ Xatolik yuz berdi. Keyinroq urinib ko'ring.",
  },
  ru: {
    welcome: "👋 Добро пожаловать!\n\nДля входа в систему Intizom поделитесь номером телефона:",
    lang_prompt: "🌐 Выберите язык",
    share_phone: "📱 Поделиться номером",
    not_found: "❌ Ваш номер не найден.\n\nОбратитесь в отдел кадров.",
    blocked: "🚫 Ваш аккаунт заблокирован.\n\nСвяжитесь с администратором.",
    success: "✅ Успешно!\n\nВаше имя: {name}\nДолжность: {title}\n\n👇 Нажмите для входа в приложение:",
    open_app: "🔓 Войти в приложение",
    cancel: "❌ Отменить",
    error: "⚠️ Ошибка. Попробуйте позже.",
  },
  en: {
    welcome: "👋 Welcome!\n\nTo sign in to Intizom, please share your phone number:",
    lang_prompt: "🌐 Select language",
    share_phone: "📱 Share phone number",
    not_found: "❌ Your number is not in the whitelist.\n\nPlease contact HR department.",
    blocked: "🚫 Your account is blocked.\n\nContact administrator.",
    success: "✅ Success!\n\nName: {name}\nPosition: {title}\n\n👇 Click below to open the app:",
    open_app: "🔓 Open app",
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
  // Kuchli, 32 belgi, bazada saqlanmaydi — faqat login uchun 1 marta
  const b = require("crypto").randomBytes(24);
  return b.toString("base64").replace(/[+/=]/g, "x");
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

  // Try linked email first
  if (preferredEmail) {
    try {
      user = await admin.auth().getUserByEmail(preferredEmail);
      emailUsed = preferredEmail;
    } catch (_) {}
  }

  // If no linked email, try phone-based email
  if (!user) {
    try {
      user = await admin.auth().getUserByEmail(phoneEmail);
      emailUsed = phoneEmail;
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
    // Create new user
    user = await admin.auth().createUser({
      email: phoneEmail,
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
        await tgApi("sendMessage", {
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
        await tgApi("answerCallbackQuery", { callback_query_id: update.callback_query.id });
        await tgApi("sendMessage", {
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
          await tgApi("sendMessage", { chat_id: chatId, text: "⚠️ Faqat o'z raqamingizni ulashing!" });
          return res.status(200).send("OK");
        }

        const phone = normalizePhone(contact.phone_number);
        const rec = await lookupWhitelist(phone);

        if (!rec) {
          await tgApi("sendMessage", { chat_id: chatId, text: t.not_found, reply_markup: { remove_keyboard: true } });
          return res.status(200).send("OK");
        }
        if (rec.active === false) {
          await tgApi("sendMessage", { chat_id: chatId, text: t.blocked, reply_markup: { remove_keyboard: true } });
          return res.status(200).send("OK");
        }

        // Create/get user with temporary password
        const { uid, email, tempPassword } = await ensureUser({ ...rec, phone });

        // Store creds with expiry for web app to pick up (one-time use)
        const loginId = "tg_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9);
        await db.ref(`tg_logins/${loginId}`).set({
          email,
          tempPassword,
          phone,
          uid,
          name: rec.name,
          createdAt: Date.now(),
          expiresAt: Date.now() + 5 * 60 * 1000, // 5 daqiqa
          used: false,
        });

        const appUrl = `https://xodimlar-7c13c.web.app/?tg=${loginId}`;

        const successMsg = t.success
          .replace("{name}", rec.name)
          .replace("{title}", rec.title || (rec.role === "admin" ? "Kadrlar" : rec.role === "boss" ? "Rahbar" : "Xodim"));

        await tgApi("sendMessage", {
          chat_id: chatId,
          text: successMsg,
          reply_markup: {
            inline_keyboard: [[{ text: t.open_app, url: appUrl }]],
          },
        });
        await tgApi("sendMessage", {
          chat_id: chatId,
          text: "🔒 " + (lang === "ru" ? "Ссылка действительна 5 минут" : lang === "en" ? "Link is valid for 5 minutes" : "Havola 5 daqiqa amal qiladi"),
          reply_markup: { remove_keyboard: true },
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
