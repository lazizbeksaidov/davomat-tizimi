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

  if (message.chat.type === "group" || message.chat.type === "supergroup") {
    await db.ref("telegram_config/chatId").set(chatId).catch(() => {});
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
    const todayKey = fmtDate(new Date());
    const [attSnap, checkSnap] = await Promise.all([
      db.ref(`attendance/${todayKey}`).once("value"),
      db.ref(`checkins/${todayKey}`).once("value")
    ]);
    const attData = attSnap.val() || {};
    const checkins = checkSnap.val() || {};
    const notDone = [];
    let skipped = 0;
    EMPLOYEES.forEach(emp => {
      const key = safeKey(emp);
      const att = attData[key];
      if (att && NON_WORKING.includes(att.status)) { skipped++; return; }
      if (att && att.status === "absent") return;
      const rec = checkins[key];
      if (!rec || !rec.morning) notDone.push(emp);
    });
    const working = EMPLOYEES.length - skipped;
    if (notDone.length === 0) {
      await sendMessage(chatId, "✅ <b>Ertalabki selfie — 09:20</b>\n\nBarcha xodimlar selfie qilgan! 👏");
      return null;
    }
    let text = `📸 <b>Ertalabki selfie — 09:20</b>\n━━━━━━━━━━━━━━━━━━\n`;
    text += `⚠️ <b>${notDone.length} xodim selfie qilmagan:</b>\n\n`;
    notDone.forEach((e, i) => { text += `${i+1}. ${e}\n`; });
    text += `\n✅ Qilgan: <b>${working - notDone.length}</b>/${working}`;
    if (skipped > 0) text += `\n🌴 Ishda emas: <b>${skipped}</b>`;
    await sendMessage(chatId, text);
    return null;
  });

// ═══ TUSHLIK SELFIE — 14:20 Dush-Juma ═══
exports.afternoonSelfieCheck = functions.pubsub
  .schedule("20 14 * * 1-5").timeZone("Asia/Tashkent")
  .onRun(async () => {
    const chatId = await getChatId();
    if (!chatId) return null;
    const todayKey = fmtDate(new Date());
    const [attSnap, checkSnap] = await Promise.all([
      db.ref(`attendance/${todayKey}`).once("value"),
      db.ref(`checkins/${todayKey}`).once("value")
    ]);
    const attData = attSnap.val() || {};
    const checkins = checkSnap.val() || {};
    const notDone = [];
    let skipped = 0;
    EMPLOYEES.forEach(emp => {
      const key = safeKey(emp);
      const att = attData[key];
      if (att && NON_WORKING.includes(att.status)) { skipped++; return; }
      if (att && att.status === "absent") return;
      const rec = checkins[key];
      if (!rec || !rec.afternoon) notDone.push(emp);
    });
    const working = EMPLOYEES.length - skipped;
    if (notDone.length === 0) {
      await sendMessage(chatId, "✅ <b>Tushlik selfie — 14:20</b>\n\nBarcha xodimlar selfie qilgan! 👏");
      return null;
    }
    let text = `📸 <b>Tushlik selfie — 14:20</b>\n━━━━━━━━━━━━━━━━━━\n`;
    text += `⚠️ <b>${notDone.length} xodim selfie qilmagan:</b>\n\n`;
    notDone.forEach((e, i) => { text += `${i+1}. ${e}\n`; });
    text += `\n✅ Qilgan: <b>${working - notDone.length}</b>/${working}`;
    if (skipped > 0) text += `\n🌴 Ishda emas: <b>${skipped}</b>`;
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
  "https://lazizbeksaidov.github.io",
  "http://localhost:5000",
  "http://localhost:3000"
];

exports.aiAnalysis = functions.https.onRequest(async (req, res) => {
  // CORS — faqat ruxsat berilgan saytlardan
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.some(o => origin.startsWith(o))) {
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
      prompt = `Sen — Navoiy viloyati Investitsiyalar boshqarmasi xodimlar intizomi bo'yicha mutaxassissan.

"${targetEmps[0]}" xodimi haqida ${months[mon]} ${yr} oyi uchun tahlil ber.

Ma'lumot:
${JSON.stringify(empStats[0], null, 1)}

Quyidagilarni o'zbek tilida tahlil qil:
1. Umumiy davomat holati
2. Kechikish sabablari tahlili (qaysi kunlarda ko'p kechikadi?)
3. Selfie intizomi (ertalab va tushlik)
4. Kuchli tomonlari
5. Yaxshilash uchun aniq tavsiyalar

${question ? "Qo'shimcha savol: " + question : ""}

Professional, qisqa va aniq yoz. Raqamlar bilan asosla.`;
    } else {
      prompt = `Sen — Navoiy viloyati Investitsiyalar boshqarmasi xodimlar intizomi bo'yicha AI yordamchisan. ${months[mon]} ${yr} oyidagi ma'lumotlar asosida javob ber.

Xodimlar: ${EMPLOYEES.join(", ")}
Ish kunlari: ${dates.length}

Ma'lumot:
${JSON.stringify(empStats.slice(0, 5), null, 1)}
... (jami ${empStats.length} xodim)

Savol: ${question}

O'zbek tilida, professional va aniq javob ber. Raqamlar bilan asosla.`;
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
        generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
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

