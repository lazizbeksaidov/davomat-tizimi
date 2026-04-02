/**
 * Firebase Cloud Functions — Xodimlar Monitoring Telegram Bot
 *
 * Deploy:
 *   cd functions && npm install
 *   firebase deploy --only functions
 *
 * Webhook o'rnatish (bir marta):
 *   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<REGION>-xodimlar-7c13c.cloudfunctions.net/telegramWebhook
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

admin.initializeApp();
const db = admin.database();

const EMPLOYEES = [
  "Azimov Ravshan","G\u2018afforov Elbek","Hamrayev Doniyorbek","Eshmatov Bekzod",
  "Haydarov Sardorbek","Tursunov Sirojiddin","Raximov Azizbek","Xolmatov Elbek",
  "Qodirov Sherzod","Abdullayev Javohir","Mamatov Ravshan","Jumayev Behruz",
  "Sultonov Doston","To\u2018xtasinov Sardor","Karimov Oybek","Nurmatov Jasurbek",
  "Sobirov Ulug\u2018bek","Raxmatullayev Nodir","Yo\u2018ldoshev Eldor","Barnoqulov Shahzod",
  "Ne\u2018matov Shahzodbek","Muhammadov Jaloliddin"
];

function safeKey(name) {
  return name.replace(/[.#$/\[\]]/g, "_");
}

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function fmtMins(m) {
  if (!m) return "—";
  if (m < 60) return `${m}d`;
  return `${Math.floor(m / 60)}s ${m % 60}d`;
}

async function getTelegramConfig() {
  const snap = await db.ref("telegram_config").once("value");
  return snap.val() || {};
}

async function sendMessage(botToken, chatId, text) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    })
  });
  return res.json();
}

async function buildDavomatReport(dateKey) {
  const snap = await db.ref(`attendance/${dateKey}`).once("value");
  const dayData = snap.val() || {};

  let present = 0, late = 0, absent = 0, sick = 0, trip = 0, training = 0, vacation = 0, excused = 0;
  const lateList = [];
  const absentList = [];

  EMPLOYEES.forEach(emp => {
    const rec = dayData[safeKey(emp)];
    const st = rec?.status || "present";
    if (st === "present") present++;
    else if (st === "late") {
      late++; present++;
      const mins = (rec?.morning || 0) + (rec?.afternoon || 0);
      lateList.push(`  ${emp.split(" ")[0]} — <b>${fmtMins(mins)}</b>`);
    }
    else if (st === "absent") { absent++; absentList.push(`  ${emp.split(" ")[0]}`); }
    else if (st === "sick") sick++;
    else if (st === "trip") trip++;
    else if (st === "training") training++;
    else if (st === "vacation") vacation++;
    else if (st === "excused") excused++;
  });

  const d = dateKey.split("-");
  const dateDisp = `${d[2]}.${d[1]}.${d[0]}`;
  const pct = Math.round(present / Math.max(1, EMPLOYEES.length) * 100);

  let text = `📊 <b>Kunlik davomat — ${dateDisp}</b>\n`;
  text += `━━━━━━━━━━━━━━━━━━\n`;
  text += `✅ Ish joyida: <b>${present}</b>/${EMPLOYEES.length}\n`;
  text += `⏰ Kechikdi: <b>${late}</b>\n`;
  text += `❌ Sababsiz: <b>${absent}</b>\n`;
  text += `🏥 Kasal: <b>${sick}</b>\n`;
  text += `✈️ Safari: <b>${trip}</b>\n`;
  if (training > 0) text += `📚 Malaka oshirish: <b>${training}</b>\n`;
  if (vacation > 0) text += `🌴 Ta'til: <b>${vacation}</b>\n`;
  if (excused > 0) text += `📋 Sababli: <b>${excused}</b>\n`;
  text += `━━━━━━━━━━━━━━━━━━\n`;
  text += `📈 Davomat: <b>${pct}%</b>`;

  if (lateList.length > 0) text += `\n\n⏰ <b>Kechikkanlar:</b>\n${lateList.join("\n")}`;
  if (absentList.length > 0) text += `\n\n❌ <b>Sababsiz yo'q:</b>\n${absentList.join("\n")}`;

  return text;
}

async function buildKechikkanlarReport(dateKey) {
  const snap = await db.ref(`attendance/${dateKey}`).once("value");
  const dayData = snap.val() || {};

  const lateList = [];
  EMPLOYEES.forEach(emp => {
    const rec = dayData[safeKey(emp)];
    if (rec?.status === "late") {
      const morning = rec.morning || 0;
      const afternoon = rec.afternoon || 0;
      lateList.push({name: emp, morning, afternoon, total: morning + afternoon});
    }
  });

  if (lateList.length === 0) return "✅ Bugun kechikkan xodim yo'q!";

  lateList.sort((a, b) => b.total - a.total);

  const d = dateKey.split("-");
  let text = `⏰ <b>Kechikkanlar — ${d[2]}.${d[1]}.${d[0]}</b>\n━━━━━━━━━━━━━━━━━━\n`;
  lateList.forEach((item, i) => {
    text += `${i + 1}. <b>${item.name}</b> — ${fmtMins(item.total)}`;
    if (item.morning > 0 && item.afternoon > 0) {
      text += ` (ert: ${item.morning}d, tush: ${item.afternoon}d)`;
    }
    text += "\n";
  });
  text += `\nJami: <b>${lateList.length}</b> xodim kechikdi`;
  return text;
}

async function buildStatistikaReport() {
  const now = new Date();
  const yr = now.getFullYear();
  const mon = now.getMonth();
  const firstDay = new Date(yr, mon, 1);
  const dates = [];
  const d = new Date(firstDay);
  while (d.getMonth() === mon) {
    const dow = d.getDay();
    if (dow >= 1 && dow <= 5) dates.push(fmtDate(new Date(d)));
    d.setDate(d.getDate() + 1);
  }

  const snap = await db.ref("attendance").once("value");
  const allData = snap.val() || {};

  let totalPresent = 0, totalLate = 0, totalAbsent = 0, totalLateMins = 0;
  const empScores = [];

  EMPLOYEES.forEach(emp => {
    let present = 0, late = 0, absent = 0, lateMins = 0;
    dates.forEach(dk => {
      const rec = allData[dk]?.[safeKey(emp)];
      const st = rec?.status || "present";
      if (st === "present") present++;
      else if (st === "late") { late++; present++; }
      else if (st === "absent") absent++;
      lateMins += (rec?.morning || 0) + (rec?.afternoon || 0);
    });
    totalPresent += present;
    totalLate += late;
    totalAbsent += absent;
    totalLateMins += lateMins;
    const score = Math.max(0, 100 - Math.round(lateMins / Math.max(1, dates.length * 480) * 100 * 8) - absent * 5 - late * 2);
    empScores.push({name: emp, score, present, late, lateMins});
  });

  empScores.sort((a, b) => b.score - a.score);
  const avgScore = Math.round(empScores.reduce((s, e) => s + e.score, 0) / Math.max(1, EMPLOYEES.length));
  const months = ["Yanvar","Fevral","Mart","Aprel","May","Iyun","Iyul","Avgust","Sentabr","Oktabr","Noyabr","Dekabr"];

  let text = `📈 <b>Oylik statistika — ${months[mon]} ${yr}</b>\n`;
  text += `━━━━━━━━━━━━━━━━━━\n`;
  text += `📅 Ish kunlari: <b>${dates.length}</b>\n`;
  text += `👥 Xodimlar: <b>${EMPLOYEES.length}</b>\n`;
  text += `✅ Jami davomat: <b>${totalPresent}</b>\n`;
  text += `⏰ Kechikishlar: <b>${totalLate}</b>\n`;
  text += `❌ Sababsiz: <b>${totalAbsent}</b>\n`;
  text += `🕐 Kechikish vaqti: <b>${fmtMins(totalLateMins)}</b>\n`;
  text += `🎯 O'rtacha intizom: <b>${avgScore}/100</b>\n`;
  text += `━━━━━━━━━━━━━━━━━━\n\n`;
  text += `🏆 <b>Top 5 xodim:</b>\n`;
  const medals = ["🥇","🥈","🥉","4️⃣","5️⃣"];
  empScores.slice(0, 5).forEach((e, i) => {
    text += `${medals[i]} ${e.name.split(" ")[0]} — <b>${e.score}</b> ball\n`;
  });

  if (empScores.length > 5) {
    text += `\n⚠️ <b>Eng past:</b>\n`;
    empScores.slice(-3).reverse().forEach(e => {
      text += `  ${e.name.split(" ")[0]} — <b>${e.score}</b> ball\n`;
    });
  }

  return text;
}

// ─── Telegram Webhook Handler ─────────────────────
exports.telegramWebhook = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") { res.status(200).send("OK"); return; }

  const cfg = await getTelegramConfig();
  if (!cfg.botToken) { res.status(200).send("No bot token"); return; }

  const body = req.body;
  const message = body?.message;
  if (!message?.text) { res.status(200).send("OK"); return; }

  const chatId = message.chat.id;
  const text = message.text.trim();
  const cmd = text.split(" ")[0].split("@")[0].toLowerCase();
  const todayKey = fmtDate(new Date());

  try {
    let reply = "";
    switch (cmd) {
      case "/davomat":
      case "/start":
        reply = await buildDavomatReport(todayKey);
        break;
      case "/kechikkanlar":
        reply = await buildKechikkanlarReport(todayKey);
        break;
      case "/statistika":
        reply = await buildStatistikaReport();
        break;
      case "/yordam":
      case "/help":
        reply = "🤖 <b>Xodimlar Monitoring Bot</b>\n\n"
          + "📊 /davomat — Bugungi kunlik davomat\n"
          + "⏰ /kechikkanlar — Kechikkan xodimlar\n"
          + "📈 /statistika — Oylik statistika\n"
          + "❓ /yordam — Ushbu yordam\n\n"
          + "📍 Navoiy viloyati Investitsiyalar,\nsanoat va savdo boshqarmasi";
        break;
      default:
        res.status(200).send("OK");
        return;
    }

    await sendMessage(cfg.botToken, chatId, reply);
  } catch (err) {
    console.error("Webhook error:", err);
    await sendMessage(cfg.botToken, chatId, "⚠ Xatolik yuz berdi. Qaytadan urinib ko'ring.").catch(() => {});
  }

  res.status(200).send("OK");
});

// ─── Scheduled Daily Report (every day at 18:00 Tashkent time) ───
exports.dailyReport = functions.pubsub
  .schedule("0 18 * * 1-5")
  .timeZone("Asia/Tashkent")
  .onRun(async () => {
    const cfg = await getTelegramConfig();
    if (!cfg.enabled || !cfg.botToken || !cfg.chatId) return null;

    const todayKey = fmtDate(new Date());
    const report = await buildDavomatReport(todayKey);
    await sendMessage(cfg.botToken, cfg.chatId, report);
    return null;
  });

// ─── Realtime: notify on new late/absent records ────
exports.onAttendanceChange = functions.database
  .ref("attendance/{dateKey}/{empKey}")
  .onWrite(async (change, context) => {
    const cfg = await getTelegramConfig();
    if (!cfg.enabled || !cfg.botToken || !cfg.chatId) return null;

    const after = change.after.val();
    const before = change.before.val();
    if (!after) return null;

    const empKey = context.params.empKey;
    const dateKey = context.params.dateKey;
    const emp = EMPLOYEES.find(e => safeKey(e) === empKey) || empKey;
    const d = dateKey.split("-");
    const dateDisp = `${d[2]}.${d[1]}.${d[0]}`;

    // Only notify on status change to absent
    if (cfg.notifyAbsent && after.status === "absent" && (!before || before.status !== "absent")) {
      const text = `❌ <b>Sababsiz yo'qlik</b>\n\n👤 <b>${emp}</b>\n📅 ${dateDisp}`;
      await sendMessage(cfg.botToken, cfg.chatId, text);
    }

    return null;
  });
