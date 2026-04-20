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

// ═══ BOT i18n ═══
const BOT_T = {
  uz: {
    lang_picker: "🌐 Tilni tanlang / Выберите язык / Select language",
    welcome: "👋 <b>Xush kelibsiz!</b>\n\n🏢 Navoiy viloyati Investitsiyalar, sanoat va savdo boshqarmasi davomat tizimi.\n\nKerakli amalni tanlang:",
    menu_login: "🔐 Tizimga kirish",
    menu_reset: "🔄 Parolni tiklash",
    menu_info: "👤 Mening ma'lumotim",
    menu_site: "🌐 Saytni ochish",
    menu_help: "❓ Yordam",
    menu_lang: "🌐 Tilni o'zgartirish",
    menu_today: "📸 Bugun",
    menu_monthly: "📊 Oylik tahlilim",
    menu_note: "💬 Izoh yozish",
    menu_vacation: "🏖 Ta'til so'rash",
    menu_birthdays: "🎂 Tug'ilgan kunlar",
    menu_champions: "🏆 Oy chempionlari",
    menu_announcements: "📢 E'lonlar",
    menu_absent_now: "🚨 Hozir kim yo'q",
    menu_today_report: "📋 Bugungi hisobot",
    menu_send_ann: "📢 E'lon yuborish",
    menu_vac_requests: "✅ Ta'til so'rovlar",
    menu_find_emp: "👥 Xodim qidirish",
    login_required: "🔐 Bu funksiya uchun avval tizimga kirishingiz kerak.\n\n/start bosing va telefon raqamingizni ulashing.",
    today_title: "📸 <b>Bugungi holat</b>\n",
    today_no_checkin: "⏳ Hali selfie olmagansiz",
    today_morning_ok: "🌅 Ertalab: <b>{time}</b> {late}",
    today_morning_none: "🌅 Ertalab: —",
    today_afternoon_ok: "🏙 Tushlik: <b>{time}</b> {late}",
    today_afternoon_none: "🏙 Tushlik: —",
    today_worked: "⏱ Ishlagan vaqt: <b>{time}</b>",
    today_status: "📊 Holat: {status}",
    monthly_title: "📊 <b>Bu oyki tahlilingiz — {month}</b>\n",
    monthly_lines: "✅ Kelgan: <b>{present}</b>\n⏰ Kechikkan: <b>{late}</b> ({lateMin} daq)\n❌ Kelmagan: <b>{absent}</b>\n🏖 Ta'tilda: <b>{vac}</b>\n\n🎯 Intizom ball: <b>{score}/100</b>",
    birthdays_title: "🎂 <b>Yaqin 30 kundagi tug'ilgan kunlar</b>\n",
    birthdays_empty: "📅 Yaqin 30 kunda tug'ilgan kun yo'q.",
    birthdays_line: "• <b>{name}</b> — {date} ({days})",
    champions_title: "🏆 <b>Oy chempionlari — {month}</b>\n",
    champions_empty: "ℹ️ Hali ma'lumot yetarli emas.",
    ann_title: "📢 <b>So'nggi e'lonlar</b>\n",
    ann_empty: "📭 Hozircha e'lon yo'q.",
    ann_line: "<b>{title}</b>\n{text}\n<i>{date}</i>\n",
    absent_title: "🚨 <b>Hozir kim yo'q — {time}</b>\n",
    absent_none: "✅ Hammasi selfie olgan!",
    absent_line: "• {name}",
    today_report_title: "📋 <b>Bugungi hisobot — {date}</b>\n",
    today_report_lines: "✅ Kelgan: <b>{present}</b>/{total}\n⏰ Kechikkan: <b>{late}</b>\n❌ Selfie olmagan: <b>{absent}</b>\n🏖 Ta'tilda: <b>{vac}</b>",
    note_type_prompt: "💬 <b>Izoh turini tanlang:</b>",
    note_type_late: "⏰ Kechikish sababi",
    note_type_absent: "🚫 Kelmadim",
    note_type_leave: "🏖 Ruxsat so'rov",
    note_type_sick: "🏥 Kasallik",
    note_type_general: "📝 Umumiy izoh",
    note_text_prompt: "✍️ <b>Izoh matnini yozib yuboring</b> (500 belgigacha):",
    note_saved: "✅ Izohingiz saqlandi!\n\n📝 Turi: <b>{type}</b>\n📅 Sana: {date}",
    vac_start_prompt: "🏖 <b>Ta'til boshlanish sanasini yozing</b>\n\nFormat: YYYY-MM-DD\nMasalan: 2026-05-10",
    vac_end_prompt: "📅 <b>Ta'til tugash sanasini yozing</b>\n\nFormat: YYYY-MM-DD",
    vac_reason_prompt: "✍️ <b>Sababni qisqa yozing</b> (majburiy emas, o'tkazish uchun <code>-</code> yuboring):",
    vac_date_invalid: "⚠️ Sana formati noto'g'ri. YYYY-MM-DD ko'rinishida yuboring (masalan: 2026-05-10)",
    vac_saved: "✅ <b>Ta'til so'rovi yuborildi!</b>\n\n📅 {start} — {end}\n✍️ Sabab: {reason}\n\n⏳ Admin tasdiqlashini kuting.",
    send_ann_title: "📢 <b>E'lon yuborish</b>\n\nAvval sarlavhani yozing:",
    send_ann_text: "📝 Endi e'lon matnini yozing:",
    send_ann_done: "✅ E'lon yuborildi!\n\n<b>{title}</b>\n{text}",
    vac_requests_title: "✅ <b>Kutilayotgan ta'til so'rovlari</b>\n",
    vac_requests_empty: "📭 Kutilayotgan so'rov yo'q.",
    vac_req_line: "<b>{name}</b>\n📅 {start} — {end}\n✍️ {reason}",
    vac_approved: "✅ <b>{name}</b> uchun ta'til tasdiqlandi!",
    vac_rejected: "❌ <b>{name}</b> so'rovi rad etildi.",
    find_emp_prompt: "👥 <b>Xodim familiyasini yozing</b>\n\nMasalan: Axadov",
    find_emp_not_found: "❌ Xodim topilmadi.",
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
function mainMenu(t, role, isLoggedIn) {
  const kb = [];
  if (!isLoggedIn) {
    kb.push([{ text: t.menu_login, callback_data: "act:login" }]);
    kb.push([{ text: t.menu_site, url: "https://xodimlar-7c13c.web.app/" }]);
    kb.push([{ text: t.menu_help, callback_data: "act:help" }, { text: t.menu_lang, callback_data: "act:lang" }]);
    return { inline_keyboard: kb };
  }
  const isAdmin = role === "admin" || role === "boss";
  // Employee rows (everyone sees)
  kb.push([{ text: t.menu_today || "📸 Bugun", callback_data: "act:today" }, { text: t.menu_monthly || "📊 Oylik", callback_data: "act:monthly" }]);
  kb.push([{ text: t.menu_note || "💬 Izoh yozish", callback_data: "act:note" }]);
  kb.push([{ text: t.menu_birthdays || "🎂 Tug'ilgan kunlar", callback_data: "act:birthdays" }, { text: t.menu_champions || "🏆 Chempionlar", callback_data: "act:champions" }]);
  kb.push([{ text: t.menu_announcements || "📢 E'lonlar", callback_data: "act:announcements" }]);
  // Admin-only rows
  if (isAdmin) {
    kb.push([{ text: t.menu_absent_now || "🚨 Hozir kim yo'q", callback_data: "act:absent_now" }]);
    kb.push([{ text: t.menu_today_report || "📋 Bugungi hisobot", callback_data: "act:today_report" }]);
    kb.push([{ text: t.menu_send_ann || "📢 E'lon yuborish", callback_data: "act:send_ann" }]);
    kb.push([{ text: t.menu_find_emp || "👥 Xodim qidirish", callback_data: "act:find_emp" }]);
  }
  // Footer
  kb.push([{ text: t.menu_site, url: "https://xodimlar-7c13c.web.app/" }]);
  kb.push([{ text: t.menu_reset, callback_data: "act:reset" }, { text: t.menu_info, callback_data: "act:info" }]);
  kb.push([{ text: t.menu_help, callback_data: "act:help" }, { text: t.menu_lang, callback_data: "act:lang" }]);
  return { inline_keyboard: kb };
}

// Get user's role + empKey from chatId. Returns null if not logged in.
async function getUserCtx(chatId) {
  const phoneSnap = await db.ref(`tg_sessions/${chatId}/linkedPhone`).once("value");
  const phone = phoneSnap.val();
  if (!phone) return null;
  const rec = await lookupWhitelist(phone);
  if (!rec) return null;
  const empKey = String(rec.name || "").replace(/[\u2018\u2019'`]/g, "").replace(/\s+/g, "_");
  return { phone, role: rec.role || "employee", name: rec.name, title: rec.title, empKey, active: rec.active !== false };
}
function shareKeyboard(t) {
  return { keyboard: [[{ text: t.share_btn, request_contact: true }]], resize_keyboard: true, one_time_keyboard: true };
}
async function sendMenu(chatId, lang) {
  const t = BOT_T[lang] || BOT_T.uz;
  const ctx = await getUserCtx(chatId);
  await tgApi("sendMessage", {
    chat_id: chatId, text: t.welcome, parse_mode: "HTML",
    reply_markup: mainMenu(t, ctx?.role, !!ctx),
  });
}

// ═══ FEATURE HELPERS ═══

// Bugun — today's status for employee
async function buildTodayStatus(ctx, t) {
  const dk = fmtDate(new Date());
  const [cSnap, aSnap] = await Promise.all([
    db.ref(`checkins/${dk}/${ctx.empKey}`).once("value"),
    db.ref(`attendance/${dk}/${ctx.empKey}`).once("value"),
  ]);
  const c = cSnap.val() || {};
  const a = aSnap.val() || { status: "present", morning: 0, afternoon: 0 };
  let out = t.today_title + "\n";
  out += (c.morning ? t.today_morning_ok.replace("{time}", c.morning.time || "—").replace("{late}", c.morning.lateMinutes > 0 ? `⏰ +${c.morning.lateMinutes} daq` : "✓") : t.today_morning_none) + "\n";
  out += (c.afternoon ? t.today_afternoon_ok.replace("{time}", c.afternoon.time || "—").replace("{late}", c.afternoon.lateMinutes > 0 ? `⏰ +${c.afternoon.lateMinutes} daq` : "✓") : t.today_afternoon_none) + "\n";
  const delay = (a.morning || 0) + (a.afternoon || 0);
  const worked = Math.max(0, 480 - delay);
  const h = Math.floor(worked / 60), m = worked % 60;
  out += "\n" + t.today_worked.replace("{time}", `${h}s ${m}daq`) + "\n";
  const stMap = { present: "✅ Vaqtida", late: "⏰ Kechikkan", absent: "❌ Kelmagan", sick: "🏥 Kasal", vacation: "🏖 Ta'tilda", trip: "✈️ Xizmat safarida", training: "📚 Malaka oshirish", excused: "📝 Ruxsat", holiday: "🎉 Bayram" };
  out += t.today_status.replace("{status}", stMap[a.status] || a.status);
  return out;
}

// Oylik tahlil
async function buildMonthlyStats(ctx, t) {
  const now = new Date();
  const yr = now.getFullYear(), mon = now.getMonth();
  const startKey = `${yr}-${String(mon + 1).padStart(2, "0")}-01`;
  const endKey = `${yr}-${String(mon + 1).padStart(2, "0")}-31`;
  const snap = await db.ref("attendance").orderByKey().startAt(startKey).endAt(endKey).once("value");
  const data = snap.val() || {};
  let present = 0, late = 0, lateMin = 0, absent = 0, vac = 0;
  for (const dk in data) {
    const rec = data[dk]?.[ctx.empKey];
    if (!rec) continue;
    const delay = (rec.morning || 0) + (rec.afternoon || 0);
    if (rec.status === "present" && delay === 0) present++;
    else if (rec.status === "late" || delay > 0) { late++; lateMin += delay; }
    else if (rec.status === "absent") absent++;
    else if (rec.status === "vacation" || rec.status === "sick" || rec.status === "trip" || rec.status === "training") vac++;
  }
  const total = present + late + absent + vac;
  const score = total > 0 ? Math.round((present * 100 + late * 70 + vac * 90) / total) : 100;
  const MONTHS_UZ = ["Yanvar","Fevral","Mart","Aprel","May","Iyun","Iyul","Avgust","Sentabr","Oktabr","Noyabr","Dekabr"];
  return t.monthly_title.replace("{month}", MONTHS_UZ[mon] + " " + yr) + "\n" +
    t.monthly_lines.replace("{present}", present).replace("{late}", late).replace("{lateMin}", lateMin).replace("{absent}", absent).replace("{vac}", vac).replace("{score}", score);
}

// Tug'ilgan kunlar — next 30 days
async function buildBirthdays(t) {
  const empSnap = await db.ref("employees").once("value");
  const emps = empSnap.val() || {};
  const today = new Date();
  const upcoming = [];
  for (const key in emps) {
    const e = emps[key];
    if (!e?.birthDate) continue;
    const match = String(e.birthDate).match(/^(\d{4})-(\d{2})-(\d{2})/) || String(e.birthDate).match(/^(\d{2})\.(\d{2})\.(\d{4})/);
    if (!match) continue;
    let m, d;
    if (match[0].includes(".")) { m = +match[2] - 1; d = +match[1]; } else { m = +match[2] - 1; d = +match[3]; }
    const thisYear = new Date(today.getFullYear(), m, d);
    let target = thisYear;
    if (target < new Date(today.getFullYear(), today.getMonth(), today.getDate())) {
      target = new Date(today.getFullYear() + 1, m, d);
    }
    const days = Math.round((target - today) / 86400000);
    if (days >= 0 && days <= 30) {
      upcoming.push({ name: e.fullName || `${e.lastName || ""} ${e.firstName || ""}`.trim(), date: `${String(d).padStart(2, "0")}.${String(m + 1).padStart(2, "0")}`, days });
    }
  }
  upcoming.sort((a, b) => a.days - b.days);
  if (upcoming.length === 0) return t.birthdays_empty;
  let out = t.birthdays_title + "\n";
  out += upcoming.slice(0, 15).map(u => t.birthdays_line.replace("{name}", u.name).replace("{date}", u.date).replace("{days}", u.days === 0 ? "BUGUN 🎉" : u.days === 1 ? "ertaga" : u.days + " kundan so'ng")).join("\n");
  return out;
}

// Oy chempionlari — top 5 by monthly score
async function buildChampions(t) {
  const now = new Date();
  const yr = now.getFullYear(), mon = now.getMonth();
  const startKey = `${yr}-${String(mon + 1).padStart(2, "0")}-01`;
  const endKey = `${yr}-${String(mon + 1).padStart(2, "0")}-31`;
  const [attSnap, empSnap] = await Promise.all([
    db.ref("attendance").orderByKey().startAt(startKey).endAt(endKey).once("value"),
    db.ref("employees").once("value"),
  ]);
  const attData = attSnap.val() || {};
  const emps = empSnap.val() || {};
  const scores = {};
  for (const key in emps) {
    scores[key] = { name: emps[key].fullName || `${emps[key].lastName || ""} ${emps[key].firstName || ""}`.trim(), present: 0, late: 0, lateMin: 0, absent: 0, total: 0 };
  }
  for (const dk in attData) {
    for (const key in attData[dk]) {
      if (!scores[key]) continue;
      const r = attData[dk][key];
      const delay = (r.morning || 0) + (r.afternoon || 0);
      scores[key].total++;
      if (r.status === "present" && delay === 0) scores[key].present++;
      else if (r.status === "late" || delay > 0) { scores[key].late++; scores[key].lateMin += delay; }
      else if (r.status === "absent") scores[key].absent++;
    }
  }
  const ranked = Object.values(scores).filter(s => s.total >= 3).map(s => {
    const pct = s.total > 0 ? Math.round((s.present * 100 + s.late * 70) / s.total) : 0;
    return { ...s, score: pct };
  }).sort((a, b) => b.score - a.score || a.lateMin - b.lateMin).slice(0, 5);
  if (ranked.length === 0) return t.champions_empty;
  const MONTHS_UZ = ["Yanvar","Fevral","Mart","Aprel","May","Iyun","Iyul","Avgust","Sentabr","Oktabr","Noyabr","Dekabr"];
  let out = t.champions_title.replace("{month}", MONTHS_UZ[mon] + " " + yr) + "\n";
  const medals = ["🥇", "🥈", "🥉", "🏅", "🏅"];
  ranked.forEach((r, i) => { out += `${medals[i] || "▫️"} <b>${r.name}</b> — ${r.score}% (kech: ${r.lateMin} daq)\n`; });
  return out;
}

// E'lonlar — last 5
async function buildAnnouncements(t) {
  const snap = await db.ref("announcements").orderByChild("timestamp").limitToLast(5).once("value");
  const d = snap.val() || {};
  const arr = Object.values(d).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  if (arr.length === 0) return t.ann_empty;
  let out = t.ann_title + "\n";
  arr.forEach(a => {
    const dt = a.timestamp ? new Date(a.timestamp).toLocaleDateString("uz-UZ") : "";
    out += t.ann_line.replace("{title}", a.title || "-").replace("{text}", (a.text || "").slice(0, 300)).replace("{date}", dt) + "\n";
  });
  return out;
}

// Hozir kim yo'q (admin)
async function buildAbsentNow(t) {
  const dk = fmtDate(new Date());
  const now = new Date();
  const curMin = now.getHours() * 60 + now.getMinutes();
  const sessionCheck = curMin < 13 * 60 ? "morning" : "afternoon";
  const [cSnap, empSnap] = await Promise.all([
    db.ref(`checkins/${dk}`).once("value"),
    db.ref("employees").once("value"),
  ]);
  const checkins = cSnap.val() || {};
  const emps = empSnap.val() || {};
  const missing = [];
  for (const key in emps) {
    const rec = checkins[key] || {};
    if (!rec[sessionCheck]) missing.push(emps[key].fullName || `${emps[key].lastName || ""} ${emps[key].firstName || ""}`.trim());
  }
  const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  if (missing.length === 0) return t.absent_title.replace("{time}", timeStr) + "\n" + t.absent_none;
  let out = t.absent_title.replace("{time}", timeStr) + "\n";
  out += `<i>(${sessionCheck === "morning" ? "ertalabki" : "tushlikdan keyingi"} selfie olmaganlar: ${missing.length} nafar)</i>\n\n`;
  out += missing.map(n => t.absent_line.replace("{name}", n)).join("\n");
  return out;
}

// Bugungi hisobot (admin)
async function buildTodayReportAdmin(t) {
  const dk = fmtDate(new Date());
  const [aSnap, empSnap, cSnap] = await Promise.all([
    db.ref(`attendance/${dk}`).once("value"),
    db.ref("employees").once("value"),
    db.ref(`checkins/${dk}`).once("value"),
  ]);
  const att = aSnap.val() || {};
  const emps = empSnap.val() || {};
  const checkins = cSnap.val() || {};
  const total = Object.keys(emps).length;
  let present = 0, late = 0, absent = 0, vac = 0;
  for (const key in emps) {
    const r = att[key] || { status: "present", morning: 0, afternoon: 0 };
    const delay = (r.morning || 0) + (r.afternoon || 0);
    const hasCheckin = !!(checkins[key]?.morning || checkins[key]?.afternoon);
    if (r.status === "vacation" || r.status === "sick" || r.status === "trip" || r.status === "training" || r.status === "excused") vac++;
    else if (r.status === "absent" || (!hasCheckin && r.status === "present")) absent++;
    else if (r.status === "late" || delay > 0) late++;
    else present++;
  }
  return t.today_report_title.replace("{date}", dk) + "\n" +
    t.today_report_lines.replace("{present}", present).replace("{total}", total).replace("{late}", late).replace("{absent}", absent).replace("{vac}", vac);
}

// Ta'til so'rovlar ro'yxati (admin)
async function buildVacRequests(t) {
  const snap = await db.ref("vacation_requests").orderByChild("status").equalTo("pending").once("value");
  const d = snap.val() || {};
  const arr = Object.entries(d).map(([id, v]) => ({ id, ...v }));
  if (arr.length === 0) return { text: t.vac_requests_title + "\n" + t.vac_requests_empty, items: [] };
  let out = t.vac_requests_title + "\n";
  arr.forEach(r => {
    out += t.vac_req_line.replace("{name}", r.name || "-").replace("{start}", r.start || "").replace("{end}", r.end || "").replace("{reason}", r.reason || "-") + "\n\n";
  });
  return { text: out, items: arr };
}

// Xodim qidirish — by name
async function buildFindEmployee(query, t) {
  const empSnap = await db.ref("employees").once("value");
  const emps = empSnap.val() || {};
  const q = query.toLowerCase();
  const matches = [];
  for (const key in emps) {
    const e = emps[key];
    const fullName = (e.fullName || `${e.lastName || ""} ${e.firstName || ""}`.trim()).toLowerCase();
    if (fullName.includes(q)) matches.push({ key, ...e });
    if (matches.length >= 5) break;
  }
  if (matches.length === 0) return t.find_emp_not_found;
  let out = "";
  for (const e of matches) {
    const name = e.fullName || `${e.lastName || ""} ${e.firstName || ""}`.trim();
    out += `👤 <b>${name}</b>\n💼 ${e.position || "-"}\n🏢 ${e.department || "-"}\n📱 ${e.phone || "-"}\n\n`;
  }
  return out;
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
        const ctx = await getUserCtx(chatId);
        await tgApi("sendMessage", { chat_id: chatId, text: t.help, parse_mode: "HTML", reply_markup: mainMenu(t, ctx?.role, !!ctx) });
        return res.status(200).send("OK");
      }

      // ═══ NEW FEATURE HANDLERS (require login) ═══
      const needLoginActs = ["act:today","act:monthly","act:note","act:birthdays","act:champions","act:announcements","act:absent_now","act:today_report","act:send_ann","act:find_emp"];
      const isAdminAct = ["act:absent_now","act:today_report","act:send_ann","act:find_emp"].includes(data);
      if (needLoginActs.includes(data) || data.startsWith("note:") || isAdminAct) {
        const lang = await getUserLang(chatId);
        const t = BOT_T[lang] || BOT_T.uz;
        const ctx = await getUserCtx(chatId);
        if (!ctx) {
          await tgApi("sendMessage", { chat_id: chatId, text: t.login_required || "🔐 Avval tizimga kiring: /start", parse_mode: "HTML" });
          return res.status(200).send("OK");
        }
        if (isAdminAct && ctx.role !== "admin" && ctx.role !== "boss") {
          await tgApi("sendMessage", { chat_id: chatId, text: "⛔ Bu funksiya faqat admin/boshliq uchun." });
          return res.status(200).send("OK");
        }

        try {
          if (data === "act:today") {
            const out = await buildTodayStatus(ctx, t);
            await tgApi("sendMessage", { chat_id: chatId, text: out, parse_mode: "HTML", reply_markup: mainMenu(t, ctx.role, true) });
            return res.status(200).send("OK");
          }
          if (data === "act:monthly") {
            const out = await buildMonthlyStats(ctx, t);
            await tgApi("sendMessage", { chat_id: chatId, text: out, parse_mode: "HTML", reply_markup: mainMenu(t, ctx.role, true) });
            return res.status(200).send("OK");
          }
          if (data === "act:birthdays") {
            const out = await buildBirthdays(t);
            await tgApi("sendMessage", { chat_id: chatId, text: out, parse_mode: "HTML", reply_markup: mainMenu(t, ctx.role, true) });
            return res.status(200).send("OK");
          }
          if (data === "act:champions") {
            const out = await buildChampions(t);
            await tgApi("sendMessage", { chat_id: chatId, text: out, parse_mode: "HTML", reply_markup: mainMenu(t, ctx.role, true) });
            return res.status(200).send("OK");
          }
          if (data === "act:announcements") {
            const out = await buildAnnouncements(t);
            await tgApi("sendMessage", { chat_id: chatId, text: out, parse_mode: "HTML", reply_markup: mainMenu(t, ctx.role, true) });
            return res.status(200).send("OK");
          }
          if (data === "act:absent_now") {
            const out = await buildAbsentNow(t);
            await tgApi("sendMessage", { chat_id: chatId, text: out, parse_mode: "HTML", reply_markup: mainMenu(t, ctx.role, true) });
            return res.status(200).send("OK");
          }
          if (data === "act:today_report") {
            const out = await buildTodayReportAdmin(t);
            await tgApi("sendMessage", { chat_id: chatId, text: out, parse_mode: "HTML", reply_markup: mainMenu(t, ctx.role, true) });
            return res.status(200).send("OK");
          }
          if (data === "act:note") {
            await setUserMode(chatId, "note:type");
            await tgApi("sendMessage", { chat_id: chatId, text: t.note_type_prompt, parse_mode: "HTML", reply_markup: {
              inline_keyboard: [
                [{ text: t.note_type_late, callback_data: "note:late" }],
                [{ text: t.note_type_absent, callback_data: "note:absent" }],
                [{ text: t.note_type_leave, callback_data: "note:leave" }],
                [{ text: t.note_type_sick, callback_data: "note:sick" }],
                [{ text: t.note_type_general, callback_data: "note:general" }],
              ]
            }});
            return res.status(200).send("OK");
          }
          if (data.startsWith("note:")) {
            const type = data.split(":")[1];
            await db.ref(`tg_sessions/${chatId}`).update({ mode: "note:text", note_type: type });
            await tgApi("sendMessage", { chat_id: chatId, text: t.note_text_prompt, parse_mode: "HTML" });
            return res.status(200).send("OK");
          }
          if (data === "act:send_ann") {
            await setUserMode(chatId, "ann:title");
            await tgApi("sendMessage", { chat_id: chatId, text: t.send_ann_title, parse_mode: "HTML" });
            return res.status(200).send("OK");
          }
          if (data === "act:find_emp") {
            await setUserMode(chatId, "find:query");
            await tgApi("sendMessage", { chat_id: chatId, text: t.find_emp_prompt, parse_mode: "HTML" });
            return res.status(200).send("OK");
          }
        } catch (err) {
          console.error("[feature handler]", data, err);
          await tgApi("sendMessage", { chat_id: chatId, text: t.err || "⚠️ Xatolik" }).catch(() => {});
          return res.status(200).send("OK");
        }
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
        const appUrl = "https://xodimlar-7c13c.web.app/";
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

      // ═══ MULTI-STEP FLOW TEXT HANDLERS ═══
      const currentMode = await getUserMode(chatId);
      const textIn = (message.text || "").trim();
      if (currentMode && textIn && !textIn.startsWith("/")) {
        const ctx = await getUserCtx(chatId);
        try {
          // Izoh yozish — step 2: save note text
          if (currentMode === "note:text" && ctx) {
            const sessSnap = await db.ref(`tg_sessions/${chatId}/note_type`).once("value");
            const noteType = sessSnap.val() || "general";
            const noteText = textIn.slice(0, 500);
            const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            await db.ref(`employee_notes/${id}`).set({
              empName: ctx.name, empKey: ctx.empKey, date: todayKey, type: noteType,
              text: noteText, timestamp: Date.now(), dateDisplay: todayKey.split("-").reverse().join(".")
            });
            await setUserMode(chatId, null);
            await db.ref(`tg_sessions/${chatId}/note_type`).remove().catch(() => {});
            const typeLabels = { late: "⏰ Kechikish", absent: "🚫 Kelmadim", leave: "🏖 Ruxsat", sick: "🏥 Kasallik", general: "📝 Umumiy" };
            await tgApi("sendMessage", { chat_id: chatId, parse_mode: "HTML",
              text: t.note_saved.replace("{type}", typeLabels[noteType] || noteType).replace("{date}", todayKey),
              reply_markup: mainMenu(t, ctx.role, true) });
            return res.status(200).send("OK");
          }
          // E'lon yuborish — admin only
          if (currentMode === "ann:title" && ctx && (ctx.role === "admin" || ctx.role === "boss")) {
            await db.ref(`tg_sessions/${chatId}`).update({ mode: "ann:text", ann_title: textIn.slice(0, 200) });
            await tgApi("sendMessage", { chat_id: chatId, text: t.send_ann_text, parse_mode: "HTML" });
            return res.status(200).send("OK");
          }
          if (currentMode === "ann:text" && ctx && (ctx.role === "admin" || ctx.role === "boss")) {
            const sessSnap = await db.ref(`tg_sessions/${chatId}`).once("value");
            const sess = sessSnap.val() || {};
            const title = sess.ann_title || "E'lon";
            const text = textIn.slice(0, 2000);
            const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            await db.ref(`announcements/${id}`).set({
              title, text, priority: "normal", timestamp: Date.now(),
              author: ctx.name, authorRole: ctx.role
            });
            await db.ref(`tg_sessions/${chatId}`).update({ mode: null, ann_title: null });
            await tgApi("sendMessage", { chat_id: chatId, parse_mode: "HTML",
              text: t.send_ann_done.replace("{title}", title).replace("{text}", text),
              reply_markup: mainMenu(t, ctx.role, true) });
            // Broadcast to all logged-in xodims via their Telegram
            const sessAll = await db.ref("tg_sessions").once("value");
            const allSess = sessAll.val() || {};
            const broadcastMsg = `📢 <b>${title}</b>\n\n${text}\n\n<i>— ${ctx.name}</i>`;
            for (const cid in allSess) {
              if (cid === String(chatId)) continue;
              if (allSess[cid].linkedPhone) {
                await tgApi("sendMessage", { chat_id: cid, text: broadcastMsg, parse_mode: "HTML" }).catch(() => {});
              }
            }
            return res.status(200).send("OK");
          }
          // Xodim qidirish — admin only
          if (currentMode === "find:query" && ctx && (ctx.role === "admin" || ctx.role === "boss")) {
            const out = await buildFindEmployee(textIn, t);
            await setUserMode(chatId, null);
            await tgApi("sendMessage", { chat_id: chatId, text: out, parse_mode: "HTML", reply_markup: mainMenu(t, ctx.role, true) });
            return res.status(200).send("OK");
          }
        } catch (err) {
          console.error("[multi-step]", currentMode, err);
        }
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
        default:
          await sendMenu(chatId, userLang);
          return res.status(200).send("OK");
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

        const appUrl = `https://xodimlar-7c13c.web.app/`;
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
