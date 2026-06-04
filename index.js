/**
 * MUHASIB PRO - PROFESSIONAL TELEGRAM BOT (V10.2 - TASHKENT TIME & EXACT PHP SYNC)
 * Barcha foydalanuvchilar (Multi-User) uchun ochiq qilingan versiya.
 * TANNARX, SOF DAROMAD, XARAJATLAR aynan PHP logic (tum.php) asosida ishlaydi.
 * Valyuta konvertatsiyasi dinamik baza orqali hisoblanadi.
 */

const TelegramBot = require('node-telegram-bot-api');
const mysql = require('mysql2/promise');
const PdfTable = require('pdfkit-table');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

// ==========================================
// ⚙️ 1. ASOSIY SOZLAMALAR VA TOKENLAR
// ==========================================
const TOKEN = '8663445751:AAFJ-6p1o2XlTYR803w8IgsDf4krTuQ9--M'; 

const DB_CONFIG = {
    host: '93.188.83.2',
    port: 33066,
    user: 'root',
    password: 'root',
    database: 'azizparfyum2025',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true
};

const pool = mysql.createPool(DB_CONFIG);
const bot = new TelegramBot(TOKEN, { polling: true });

let lastQaydId = null; 
let isChecking = false;

// 👥 FOYDALANUVCHILARNI SAQLASH TIZIMI (Multi-User)
const SUBSCRIBERS_FILE = path.join(__dirname, 'subscribers.json');
let subscribers = new Set();

if (fs.existsSync(SUBSCRIBERS_FILE)) {
    try {
        const data = JSON.parse(fs.readFileSync(SUBSCRIBERS_FILE, 'utf-8'));
        subscribers = new Set(data);
    } catch (e) {
        console.error("Subscribers faylini o'qishda xatolik:", e);
    }
}

function addSubscriber(chatId) {
    if (!subscribers.has(chatId)) {
        subscribers.add(chatId);
        fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify([...subscribers]));
        console.log(`✅ Yangi foydalanuvchi qo'shildi: ${chatId}`);
    }
}

console.log('⏳ Bot va Ma\'lumotlar bazasi ishga tushmoqda...');

// ==========================================
// 🛠️ YORDAMCHI FUNKSIYALAR (TIME & FORMAT)
// ==========================================
function getTashkentDate() {
    const date = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Tashkent"}));
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

function getYesterdayTashkentDate() {
    const date = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Tashkent"}));
    date.setDate(date.getDate() - 1); // 1 kun orqaga
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

function formatNumber(num) {
    return Number(num || 0).toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function formatPdfNumber(num) {
    const val = Number(num || 0);
    if (Math.abs(val) < 0.01) return "-";
    return val.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function formatPdfPercent(num) {
    const val = Number(num || 0);
    if (Math.abs(val) < 0.01) return "-";
    return val.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' %';
}

function cleanCur(val) {
    if (!val) return "SO'M";
    let v = val.toLowerCase();
    if (v.includes('usd') || v.includes('dollar')) return 'USD';
    if (v.includes('som') || v.includes('so\'m') || v.includes('сум') || v.includes('uzs')) return "SO'M";
    return val;
}

// ==========================================
// 💱 VALYUTA KONVERTATSIYASI (PHP tum.php dan)
// ==========================================
async function getValutaContext() {
    const [valutaRows] = await pool.query("SELECT id, valuta, status FROM valuta ORDER BY id");
    const [kursRows] = await pool.query("SELECT valuta, kurs FROM kurs ORDER BY id DESC LIMIT 200");

    let usdId = 1, uzsId = 2;
    valutaRows.forEach(v => {
        let name = (v.valuta || "").toLowerCase().trim();
        if (name.includes("so'm") || name.includes("som") || name.includes("uzs") || name.includes("сум")) uzsId = v.id;
        if (name === "usd" || name.includes("dollar") || name.includes("$")) usdId = v.id;
    });

    let kursMap = {};
    kursRows.forEach(r => {
        if (!kursMap[r.valuta] && Number(r.kurs) > 0) kursMap[r.valuta] = Number(r.kurs);
    });

    let baseId = 0;
    valutaRows.forEach(v => { if (Number(v.status) === 1) baseId = v.id; });
    if (!baseId) {
        let bestDiff = 1e18;
        for (let vid in kursMap) {
            let diff = Math.abs(kursMap[vid] - 1.0);
            if (diff < bestDiff) { bestDiff = diff; baseId = Number(vid); }
        }
    }
    if (!baseId) baseId = usdId > 0 ? usdId : (uzsId || 1);

    kursMap[baseId] = 1.0;
    valutaRows.forEach(v => {
        if (!kursMap[v.id] || kursMap[v.id] <= 0) kursMap[v.id] = 1.0;
    });

    return { baseId, usdId, uzsId, kursMap };
}

function getSqlPriceConverted(alias, targetValutaId, ctx) {
    let baseId = ctx.baseId;
    let tRate = ctx.kursMap[targetValutaId] || 1.0;
    let baseExpr = `(CASE WHEN ${alias}.valuta = ${baseId} THEN ${alias}.narh ELSE ${alias}.narh / COALESCE(NULLIF(${alias}.kurs,0), 1) END)`;
    if (targetValutaId === baseId) return `(${baseExpr})`;
    return `((${baseExpr}) * ${tRate})`;
}

// ⌨️ INPUT TAGIDAGI ASOSIY MENYU TUGMALARI
const mainMenu = {
    reply_markup: {
        keyboard: [
            [{ text: "💰 Pul hisobi (Kassa)" }, { text: "📊 Bugungi savdolar" }],
            [{ text: "📜 Sotuvlar tarixi" }, { text: "📄 PDF Hisobot (Kecha)" }]
        ],
        resize_keyboard: true
    }
};

// ==========================================
// 🛡️ 2. ASOSIY KOMANDALAR VA MENYULAR
// ==========================================
bot.onText(/\/(start|menu|ping)/, (msg) => {
    const chatId = msg.chat.id;
    addSubscriber(chatId); // Foydalanuvchini bazaga qo'shish
    bot.sendMessage(chatId, `🟢 <b>Muhasib PRO Boshqaruv Paneli</b>\n\nQuyidagi menyulardan foydalaning:`, { parse_mode: 'HTML', ...mainMenu });
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (text.startsWith('/')) return;
    addSubscriber(chatId); // Har ehtimolga qarshi yozganda ham xotiraga olish

    try {
        if (text === "💰 Pul hisobi (Kassa)") {
            const [kassalar] = await pool.query(`
                SELECT 
                    h.text as nomi, h.mavqe, COALESCE(v.valuta, 'SO\\'M') as valNomi,
                    SUM(CASE WHEN hk.hisob2 = h.id THEN hk.narh ELSE 0 END) - 
                    SUM(CASE WHEN hk.hisob1 = h.id THEN hk.narh ELSE 0 END) AS qoldiq
                FROM hisob h
                JOIN hisobkitob hk ON (hk.hisob1 = h.id OR hk.hisob2 = h.id)
                LEFT JOIN valuta v ON v.id = hk.valuta
                WHERE h.mavqe IN (2, 8) AND hk.tovar = 0 AND hk.amal != 17
                GROUP BY h.id, h.text, h.mavqe, hk.valuta, v.valuta
                HAVING ABS(qoldiq) > 0.01
                ORDER BY h.mavqe ASC, h.text ASC
            `);

            let msgText = `💰 <b>KASSA QOLDIQLARI:</b>\n━━━━━━━━━━━━━━━━━━━━━\n`;
            let currentHisob = "";

            if (kassalar.length > 0) {
                kassalar.forEach(k => {
                    const tur = k.mavqe === 2 ? '💵' : '💳';
                    if (currentHisob !== k.nomi) {
                        msgText += `\n${tur} <b>${k.nomi}:</b>\n`;
                        currentHisob = k.nomi;
                    }
                    msgText += `   └ ${formatNumber(k.qoldiq)} <b>${cleanCur(k.valNomi)}</b>\n`;
                });
            } else {
                msgText += `<i>Hozircha pul hisoblari bo'sh.</i>`;
            }
            bot.sendMessage(chatId, msgText, { parse_mode: 'HTML', ...mainMenu });
        }
        else if (text === "📊 Bugungi savdolar") {
            const today = getTashkentDate();
            const [rows] = await pool.query(`
                SELECT q.id as qaydId, hk.dona, hk.narh, COALESCE(v.valuta, 'SO\\'M') as valNomi
                FROM qaydnoma q
                JOIN hisobkitob hk ON hk.qaydId = q.id
                LEFT JOIN valuta v ON v.id = hk.valuta
                WHERE DATE(q.dateTime) = ? AND q.amalTuri = 4 AND hk.tovar > 0 AND hk.amal IN (4, 30) AND hk.hisob2 = q.kirimId
            `, [today]);

            let cheklarSet = new Set();
            let jamiNative = {};

            rows.forEach(r => {
                cheklarSet.add(r.qaydId);
                let cur = cleanCur(r.valNomi);
                jamiNative[cur] = (jamiNative[cur] || 0) + (Number(r.dona) * Number(r.narh));
            });

            let msgText = `📊 <b>BUGUNGI SAVDOLAR (${today})</b>\n━━━━━━━━━━━━━━━━━━━━━\n`;
            msgText += `🛍 <b>Sotilgan cheklar soni:</b> ${cheklarSet.size} ta\n`;
            msgText += `💸 <b>Jami savdo:</b>\n`;
            
            if (Object.keys(jamiNative).length > 0) {
                Object.entries(jamiNative).forEach(([c, v]) => msgText += `   └ ${formatNumber(v)} <b>${c}</b>\n`);
            } else msgText += `   └ 0\n`;
            
            bot.sendMessage(chatId, msgText, { parse_mode: 'HTML', ...mainMenu });
        }
        else if (text === "📜 Sotuvlar tarixi") {
            await sendHistoryPage(chatId, 0);
        }
        else if (text === "📄 PDF Hisobot (Kecha)" || text === "📄 PDF Hisobot (Bugun)") {
            bot.sendMessage(chatId, "⏳ Mukammal PDF hisobot tayyorlanmoqda, kuting...");
            await generateAndSendPDF(chatId);
        }
    } catch (error) {
        console.error("Xato:", error);
        bot.sendMessage(chatId, "❌ Xatolik yuz berdi!");
    }
});

// ==========================================
// 🖱️ 3. INLINE TUGMALAR (Varaqlash)
// ==========================================
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const data = query.data; 

    addSubscriber(chatId);

    try {
        if (data.startsWith('history_')) {
            const offset = parseInt(data.split('_')[1]);
            await sendHistoryPage(chatId, offset, messageId);
        }
        else if (data.startsWith('detail_')) {
            const parts = data.split('_');
            const qaydId = parts[1];
            const backOffset = parts[2]; 
            await sendReceiptDetail(chatId, qaydId, messageId, backOffset, false);
        }
        bot.answerCallbackQuery(query.id);
    } catch (error) {
        console.error("Callback xatosi:", error);
        bot.answerCallbackQuery(query.id, { text: "Xatolik yuz berdi!", show_alert: true });
    }
});

async function sendHistoryPage(chatId, offset, messageId = null) {
    const limit = 10;
    const [savdolar] = await pool.query(`
        SELECT q.id, q.hujjat, q.kirimId, (SELECT text FROM hisob WHERE id = q.kirimId) as mijozNomi
        FROM qaydnoma q WHERE q.amalTuri = 4 ORDER BY q.id DESC LIMIT ? OFFSET ?
    `, [limit, offset]);

    let text = `📜 <b>SOTUVLAR TARIXI</b>\n<i>Hujjat tafsilotini ko'rish uchun ustiga bosing:</i>\n\n`;
    let keyboard = [];

    if (savdolar.length > 0) {
        const ids = savdolar.map(s => s.id);
        const [items] = await pool.query(`
            SELECT hk.qaydId, hk.hisob2, hk.dona, hk.narh, COALESCE(v.valuta, 'SO\\'M') as valNomi
            FROM hisobkitob hk LEFT JOIN valuta v ON v.id = hk.valuta 
            WHERE hk.qaydId IN (?) AND hk.tovar > 0 AND hk.amal IN (4,30)
        `, [ids.length > 0 ? ids : [0]]);

        savdolar.forEach(s => {
            let jamiVals = {};
            items.filter(i => i.qaydId === s.id && i.hisob2 === s.kirimId).forEach(it => {
                let c = cleanCur(it.valNomi);
                jamiVals[c] = (jamiVals[c] || 0) + (Number(it.dona) * Number(it.narh));
            });
            let jamiText = Object.entries(jamiVals).map(([c, v]) => `${formatNumber(v)} ${c}`).join(' + ') || '0';
            keyboard.push([{ text: `📄 #${s.hujjat} | 👤 ${s.mijozNomi || 'Mijoz'} | 💰 ${jamiText}`, callback_data: `detail_${s.id}_${offset}` }]);
        });

        let navButtons = [];
        if (offset > 0) navButtons.push({ text: '⬅️ Oldingi', callback_data: `history_${offset - limit}` });
        if (savdolar.length === limit) navButtons.push({ text: 'Keyingi ➡️', callback_data: `history_${offset + limit}` });
        if (navButtons.length > 0) keyboard.push(navButtons);
    } else {
        text += `<i>Boshqa savdo topilmadi.</i>\n`;
    }

    const options = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
    if (messageId) bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
    else bot.sendMessage(chatId, text, options);
}

// ==========================================
// 🧾 4. MUKAMMAL QARZ VA CHЕK TAFSILOTI
// ==========================================
async function sendReceiptDetail(chatId, qaydId, messageId = null, backOffset = null, isNotification = false) {
    const [qaydRows] = await pool.query(`
        SELECT q.*, 
               (SELECT text FROM hisob WHERE id = q.chiqimId) as omborNomi,
               (SELECT text FROM hisob WHERE id = q.kirimId) as mijozNomi,
               (SELECT ism FROM users WHERE id = q.userId) as sotuvchiNomi
        FROM qaydnoma q WHERE id = ?
    `, [qaydId]);
    const q = qaydRows[0];
    if (!q) return;

    const [valutaRows] = await pool.query("SELECT * FROM valuta");
    let somId = 2; 
    valutaRows.forEach(v => {
        let name = v.valuta.toLowerCase();
        if (name.includes('som') || name.includes("so'm") || name.includes('uzs') || name.includes('сум')) somId = v.id;
    });

    const [hkRows] = await pool.query(`
        SELECT hk.amal, hk.tovar, hk.dona, hk.narh, hk.kurs, hk.valuta, hk.hisob1, hk.hisob2, hk.izoh as tovarNomi, hk.barCode as serial,
               COALESCE(v.valuta, 'SO\\'M') as valNomi
        FROM hisobkitob hk LEFT JOIN valuta v ON v.id = hk.valuta 
        WHERE hk.qaydId = ?
    `, [qaydId]);

    let jamiNative = {};    
    let tolandiNative = {}; 
    let qaytimNative = {};
    let foydaUsd = 0;       
    let zararUsd = 0;       
    let saleSomUnified = 0;   
    let paidSomUnified = 0;
    let currentSomKurs = 12500; 
    let tovarlarMatni = ``;
    let tovarSoni = 1;

    hkRows.forEach(hk => { if (Number(hk.kurs) > 100) currentSomKurs = Number(hk.kurs); });

    hkRows.forEach(hk => {
        let cur = cleanCur(hk.valNomi);
        let narh = Number(hk.narh || 0);
        let dona = Number(hk.dona || 0);
        let valId = Number(hk.valuta || somId);
        
        let native = (hk.tovar > 0) ? (dona * narh) : narh;
        let isSom = (valId === somId || cur === "SO'M");
        let sumInSom = isSom ? native : (native * currentSomKurs);

        if (hk.tovar > 0 && [4, 30].includes(hk.amal)) {
            if (hk.hisob2 == q.kirimId) {
                saleSomUnified += sumInSom;
                jamiNative[cur] = (jamiNative[cur] || 0) + native;
                let tNomi = hk.tovarNomi || 'Nomsiz tovar';
                if (hk.serial) tNomi += ` <i>(SN: ${hk.serial})</i>`;
                tovarlarMatni += `${tovarSoni}. <b>${tNomi}</b>\n   └ ${formatNumber(dona)} x ${formatNumber(narh)} ${cur} = ${formatNumber(native)} <b>${cur}</b>\n`;
                tovarSoni++;
            }
            if (hk.hisob1 == q.kirimId) saleSomUnified -= sumInSom;
        } else if (hk.tovar === 0) {
            if (hk.amal === 18 && hk.hisob2 == q.kirimId) saleSomUnified += sumInSom;
            if (hk.amal === 17 && hk.hisob2 == q.kirimId) saleSomUnified += sumInSom;
            if (hk.amal === 17 && hk.hisob1 == q.kirimId) saleSomUnified -= sumInSom;

            if ([7, 15, 13].includes(hk.amal) && hk.hisob1 == q.kirimId) {
                paidSomUnified += sumInSom;
                tolandiNative[cur] = (tolandiNative[cur] || 0) + native;
            }
            if (hk.amal === 8 && hk.hisob2 == q.kirimId) {
                paidSomUnified -= sumInSom;
                qaytimNative[cur] = (qaytimNative[cur] || 0) + native;
            }
            if (hk.amal === 9) foydaUsd += narh;
            if (hk.amal === 12) zararUsd += narh;
        }
    });

    let qarzSomUnified = saleSomUnified - paidSomUnified;
    let jamiText = Object.entries(jamiNative).map(([c, v]) => `${formatNumber(v)} <b>${c}</b>`).join(' + ') || `0 SO'M`;
    let tolandiText = Object.entries(tolandiNative).filter(([c, v]) => Math.abs(v) > 0.01).map(([c, v]) => `${formatNumber(v)} <b>${c}</b>`).join(' + ') || `0 SO'M`;
    let qaytimText = Object.entries(qaytimNative).filter(([c, v]) => Math.abs(v) > 0.01).map(([c, v]) => `${formatNumber(v)} <b>${c}</b>`).join(' + ') || ``;

    let sarlavha = isNotification ? `🆕 <b>YANGI SAVDO: #${q.hujjat}</b>` : `🛒 <b>SAVDO TAFSILOTI: #${q.hujjat}</b>`;
    let text = `${sarlavha}\n━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `📅 <b>Vaqt:</b> ${new Date(q.dateTime).toLocaleString('ru-RU', {timeZone: 'Asia/Tashkent'})}\n`;
    text += `👤 <b>Sotuvchi:</b> ${q.sotuvchiNomi || 'Noma\'lum'}\n`;
    text += `🤝 <b>Xaridor:</b> ${q.mijozNomi || 'Noma\'lum'}\n━━━━━━━━━━━━━━━━━━━━━\n\n`;
    text += `📦 <b>SOTILGAN TOVARLAR:</b>\n${tovarlarMatni || '<i>Tovarlar yo\'q</i>\n'}\n━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `💵 <b>JAMI SAVDO:</b> ${jamiText}\n`;
    text += `✅ <b>TO'LANDI:</b> ${tolandiText}\n`;
    if (qaytimText !== '') text += `🔙 <b>QAYTIM BERILDI:</b> ${qaytimText}\n`;
    
    if (qarzSomUnified > 0.01) {
        let qarzUsd = qarzSomUnified / currentSomKurs;
        text += `🔴 <b>QARZGA QOLDI:</b> ${formatNumber(qarzSomUnified)} <b>SO'M</b> <i>(${formatNumber(qarzUsd)} USD)</i>\n`;
    } else if (qarzSomUnified < -0.01) {
        text += `🔵 <b>ORTIQCHA TO'LOV:</b> ${formatNumber(Math.abs(qarzSomUnified))} <b>SO'M</b>\n`;
    } else {
        text += `✅ <b>QARZ:</b> 0\n`;
    }

    text += `\n📈 <b>MOLIYAVIY NATIJA:</b>\n`;
    if (foydaUsd > 0) text += `🟩 <b>Foyda:</b> ${formatNumber(foydaUsd * currentSomKurs)} SO'M\n`;
    if (zararUsd > 0) text += `🟥 <b>Zarar:</b> -${formatNumber(zararUsd * currentSomKurs)} SO'M\n`;

    let keyboard = [];
    if (backOffset !== null) keyboard.push([{ text: '🔙 Tarixga qaytish', callback_data: `history_${backOffset}` }]);

    const options = { parse_mode: 'HTML', reply_markup: keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined };
    if (messageId) bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
    else bot.sendMessage(chatId, text, options);
}

// ==========================================
// 📄 5. PDF HISOBOT (EXCEL DARAJASIDAGI FORMAT)
// ==========================================
async function generateAndSendPDF(chatId) {
    try {
        const targetDate = getYesterdayTashkentDate(); 
        
        // Context for Currency (Convert to UZS base)
        const ctx = await getValutaContext();
        const targetValutaId = ctx.uzsId; 
        
        const priceExpr = getSqlPriceConverted('hk', targetValutaId, ctx);
        const sumExpr = `(hk.dona * ${priceExpr})`;
        const amtExpr = `(IF(hk.tovar=0,1,hk.dona) * ${priceExpr})`;
        const dateCol = 'dateTime'; 
        const bcCol = 'barCode';

        // 1. SAVDO 
        const [savdoRows] = await pool.query(`
            SELECT SUM(${sumExpr}) as narx
            FROM hisobkitob hk
            WHERE DATE(hk.${dateCol}) = ?
              AND hk.amal = 4
              AND hk.hisob1 IN (SELECT id2 FROM tranzithisob)
              AND hk.tovar > 0
              AND IFNULL(hk.${bcCol}, '') <> ''
        `, [targetDate]);
        const yalpiSavdo = Number(savdoRows[0]?.narx || 0);

        // 2. TANNARX
        const [tannarxRows] = await pool.query(`
            SELECT SUM(${sumExpr}) as narx
            FROM hisobkitob hk
            WHERE DATE(hk.${dateCol}) = ?
              AND hk.amal = 4
              AND hk.hisob2 IN (SELECT id2 FROM tranzithisob)
              AND hk.tovar > 0
              AND IFNULL(hk.${bcCol}, '') <> ''
        `, [targetDate]);
        const tannarx = Number(tannarxRows[0]?.narx || 0);

        // 3. ZARAR
        const [zararRows] = await pool.query(`
            SELECT SUM(${sumExpr}) as narx
            FROM hisobkitob hk
            WHERE hk.amal = 12 AND DATE(hk.${dateCol}) = ?
        `, [targetDate]);
        const zarar = Number(zararRows[0]?.narx || 0);

        // 4. XARAJATLAR (mavqe 5,7,9,14,15)
        const [xarajatRows] = await pool.query(`
            SELECT SUM(IFNULL(net.narx,0)) as narx
            FROM hisob h
            LEFT JOIN (
                SELECT x.hisob_id, (IFNULL(x.kirim,0) - IFNULL(x.chiqim,0)) as narx
                FROM (
                    SELECT h.id as hisob_id,
                           SUM(CASE WHEN hk.hisob2=h.id THEN ${amtExpr} ELSE 0 END) as kirim,
                           SUM(CASE WHEN hk.hisob1=h.id THEN ${amtExpr} ELSE 0 END) as chiqim
                    FROM hisob h
                    LEFT JOIN hisobkitob hk ON (hk.hisob1=h.id OR hk.hisob2=h.id) AND DATE(hk.${dateCol}) = ?
                    GROUP BY h.id
                ) x
            ) net ON net.hisob_id=h.id
            WHERE h.mavqe IN (5,7,9,14,15)
        `, [targetDate]);
        const xarajatJami = Number(xarajatRows[0]?.narx || 0);

        // 5. SOF DAROMAD NET (mavqe 4,5,7,9,13,14,15)
        const [sofNetRows] = await pool.query(`
            SELECT SUM(IFNULL(net.narx,0)) as narx
            FROM hisob h
            LEFT JOIN (
                SELECT x.hisob_id, (IFNULL(x.kirim,0) - IFNULL(x.chiqim,0)) as narx
                FROM (
                    SELECT h.id as hisob_id,
                           SUM(CASE WHEN hk.hisob2=h.id THEN ${amtExpr} ELSE 0 END) as kirim,
                           SUM(CASE WHEN hk.hisob1=h.id THEN ${amtExpr} ELSE 0 END) as chiqim
                    FROM hisob h
                    LEFT JOIN hisobkitob hk ON (hk.hisob1=h.id OR hk.hisob2=h.id) AND DATE(hk.${dateCol}) = ?
                    GROUP BY h.id
                ) x
            ) net ON net.hisob_id=h.id
            WHERE h.mavqe IN (4,5,7,9,13,14,15)
        `, [targetDate]);
        const sofDaromad = -1 * Number(sofNetRows[0]?.narx || 0);

        const yalpiFoyda = yalpiSavdo - tannarx;

        // Foizlar
        const yalpiFoiz = tannarx != 0 ? ((yalpiSavdo / tannarx) - 1) * 100 : 0;
        const den2 = tannarx + xarajatJami;
        const sofFoiz = den2 != 0 ? ((yalpiSavdo / den2) - 1) * 100 : 0;

        // ===============================================
        // PUL OQIMI (PHP fayldagi accounts_list() UNION ALL mantiqi asosida yozildi)
        // ===============================================
        const [cashFlow] = await pool.query(`
            SELECT h.text as nomi,
                   COALESCE(op.opening, 0) AS boshlangich,
                   COALESCE(pr.kirim, 0) AS kirim,
                   COALESCE(pr.chiqim, 0) AS chiqim,
                   (COALESCE(op.opening, 0) + COALESCE(pr.kirim, 0) - COALESCE(pr.chiqim, 0)) AS qoldiq
            FROM hisob h
            LEFT JOIN (
                SELECT hisob_id, SUM(amount) AS opening
                FROM (
                    SELECT hk.hisob1 AS hisob_id, SUM(-(${amtExpr})) AS amount
                    FROM hisobkitob hk
                    WHERE hk.tovar = 0 AND hk.valuta > 0 AND DATE(hk.${dateCol}) < ?
                    GROUP BY hk.hisob1
                    UNION ALL
                    SELECT hk.hisob2 AS hisob_id, SUM(${amtExpr}) AS amount
                    FROM hisobkitob hk
                    WHERE hk.tovar = 0 AND hk.valuta > 0 AND DATE(hk.${dateCol}) < ?
                    GROUP BY hk.hisob2
                ) x
                GROUP BY hisob_id
            ) op ON op.hisob_id = h.id
            LEFT JOIN (
                SELECT hisob_id, 
                       SUM(CASE WHEN turi = 'in' THEN amount ELSE 0 END) AS kirim,
                       SUM(CASE WHEN turi = 'out' THEN amount ELSE 0 END) AS chiqim
                FROM (
                    SELECT hk.hisob1 AS hisob_id, 'out' AS turi, SUM(${amtExpr}) AS amount
                    FROM hisobkitob hk
                    WHERE hk.tovar = 0 AND hk.valuta > 0 AND DATE(hk.${dateCol}) = ?
                    GROUP BY hk.hisob1
                    UNION ALL
                    SELECT hk.hisob2 AS hisob_id, 'in' AS turi, SUM(${amtExpr}) AS amount
                    FROM hisobkitob hk
                    WHERE hk.tovar = 0 AND hk.valuta > 0 AND DATE(hk.${dateCol}) = ?
                    GROUP BY hk.hisob2
                ) y
                GROUP BY hisob_id
            ) pr ON pr.hisob_id = h.id
            WHERE h.mavqe IN (2, 8)
            HAVING ABS(boshlangich) > 0.01 OR ABS(kirim) > 0.01 OR ABS(chiqim) > 0.01 OR ABS(qoldiq) > 0.01
        `, [targetDate, targetDate, targetDate, targetDate]);

        // OMBOR QOLDIQLARI
        const [qoldiqlar] = await pool.query(`
            SELECT t.text as nomi,
                   SUM(CASE WHEN hk.hisob2 > 0 THEN hk.dona ELSE 0 END) - 
                   SUM(CASE WHEN hk.hisob1 > 0 THEN hk.dona ELSE 0 END) as jami_dona,
                   (SUM(CASE WHEN hk.hisob2 > 0 THEN hk.dona ELSE 0 END) - 
                   SUM(CASE WHEN hk.hisob1 > 0 THEN hk.dona ELSE 0 END)) * MAX(${priceExpr}) as qoldiq_summasi
            FROM hisobkitob hk JOIN tovar t ON t.id = hk.tovar 
            WHERE hk.tovar > 0 
            GROUP BY hk.tovar, t.text 
            HAVING jami_dona != 0 
            ORDER BY qoldiq_summasi DESC LIMIT 15
        `);

        // XODIMLAR (Faqat shu kuni savdo qilganlar)
        const [sellers] = await pool.query(`
            SELECT hk.userId, u.ism,
                   COUNT(DISTINCT CASE WHEN hk.hisob1 IN (SELECT id2 FROM tranzithisob) THEN hk.qaydId ELSE NULL END) as cheklar,
                   SUM(CASE WHEN hk.hisob1 IN (SELECT id2 FROM tranzithisob) THEN ${sumExpr} ELSE 0 END) as savdo,
                   SUM(CASE WHEN hk.hisob2 IN (SELECT id2 FROM tranzithisob) THEN ${sumExpr} ELSE 0 END) as tannarx
            FROM hisobkitob hk LEFT JOIN users u ON u.id = hk.userId
            WHERE DATE(hk.${dateCol}) = ? AND hk.amal = 4 AND hk.tovar > 0 AND IFNULL(hk.${bcCol}, '') <> ''
              AND (hk.hisob1 IN (SELECT id2 FROM tranzithisob) OR hk.hisob2 IN (SELECT id2 FROM tranzithisob))
            GROUP BY hk.userId, u.ism
            HAVING savdo > 0
            ORDER BY savdo DESC LIMIT 15
        `, [targetDate]);

        // TOP TOVARLAR
        const priceSot = getSqlPriceConverted('sotuv', targetValutaId, ctx);
        const priceTan = getSqlPriceConverted('tannarx', targetValutaId, ctx);
        const [products] = await pool.query(`
            SELECT t.text,
                   SUM(sotuv.dona) as dona,
                   SUM(sotuv.dona * ${priceSot}) as savdo,
                   SUM(sotuv.dona * ${priceTan}) as tannarx
            FROM hisobkitob sotuv
            LEFT JOIN tovar t ON t.id = sotuv.tovar
            LEFT JOIN hisobkitob tannarx ON tannarx.qaydId = sotuv.qaydId AND tannarx.amal = 4 AND tannarx.tovar = sotuv.tovar AND tannarx.barCode = sotuv.barCode AND tannarx.dateTime = sotuv.dateTime AND tannarx.hisob2 IN (SELECT id2 FROM tranzithisob)
            WHERE sotuv.amal = 4 AND sotuv.hisob1 IN (SELECT id2 FROM tranzithisob) AND DATE(sotuv.dateTime) = ? AND sotuv.tovar > 0
            GROUP BY sotuv.tovar, t.text
            ORDER BY savdo DESC LIMIT 10
        `, [targetDate]);

        // ISHLAB CHIQARISH
        const [ishlabChiqarish] = await pool.query(`
            SELECT q.hujjat, t.text as mahsulot, 
                   SUM(CASE WHEN hk.hisob2 > 0 THEN hk.dona ELSE 0 END) as ishlangan_dona,
                   SUM(CASE WHEN hk.hisob1 > 0 THEN hk.dona ELSE 0 END) as sarf_dona,
                   SUM(${amtExpr}) as jami_summa
            FROM hisobkitob hk 
            JOIN qaydnoma q ON q.id = hk.qaydId JOIN tovar t ON t.id = hk.tovar
            WHERE q.amalTuri = 5 AND DATE(q.dateTime) = ? AND hk.tovar > 0
            GROUP BY hk.qaydId, q.hujjat, t.text
        `, [targetDate]);

        // CHIQIMLAR (Xarajatlar kesimida: bugungi)
        const [chiqimlar] = await pool.query(`
            SELECT h.text as kategoriya,
                   SUM(IFNULL(net.narx,0)) as jami
            FROM hisob h
            LEFT JOIN (
                SELECT x.hisob_id, (IFNULL(x.kirim,0) - IFNULL(x.chiqim,0)) narx
                FROM (
                    SELECT h.id as hisob_id,
                           SUM(CASE WHEN hk.hisob2=h.id THEN ${amtExpr} ELSE 0 END) as kirim,
                           SUM(CASE WHEN hk.hisob1=h.id THEN ${amtExpr} ELSE 0 END) as chiqim
                    FROM hisob h
                    LEFT JOIN hisobkitob hk ON (hk.hisob1=h.id OR hk.hisob2=h.id) AND DATE(hk.${dateCol}) = ?
                    GROUP BY h.id
                ) x
            ) net ON net.hisob_id=h.id
            WHERE h.mavqe IN (5, 7, 9, 14, 15)
            GROUP BY h.id, h.text
            HAVING jami != 0
            ORDER BY jami DESC
        `, [targetDate]);

        // ===============================================
        // 📄 PDF YARATISH (EXCEL DARAJASIDAGI DIZAYN)
        // ===============================================
        const doc = new PdfTable({ margin: 40, size: 'A4' });
        const filePath = path.join(__dirname, `Muhasib_Hisobot_${targetDate}_${chatId}.pdf`); // Fayl nomi chatId bilan birga (ziddiyat bo'lmasligi uchun)
        const stream = fs.createWriteStream(filePath);
        doc.pipe(stream);

        // 🎨 Sarlavha dizayni
        doc.font('Helvetica-Bold').fontSize(18).fillColor('#1F4E79').text('MUHASIB PRO - KUNLIK MOLIYAVIY HISOBOT', { align: 'center' });
        doc.font('Helvetica').fontSize(10).fillColor('#595959').text(`Sana: ${targetDate} (Kechagi) | Barcha summalar SO'Mda hisoblangan`, { align: 'center' });
        doc.moveDown(1.5);

        // ⚙️ GLOBAL JADVAL STILI (Qora chiziqlar, Zebra fon)
        const tableStyle = {
            padding: 5,
            columnSpacing: 5,
            divider: {
                header: { disabled: false, width: 1.5, opacity: 1, color: '#1F4E79' },
                horizontal: { disabled: false, width: 0.5, opacity: 0.8, color: '#BFBFBF' },
                vertical: { disabled: false, width: 0.5, opacity: 0.8, color: '#BFBFBF' }
            },
            prepareHeader: () => doc.font("Helvetica-Bold").fontSize(9).fillColor('#FFFFFF'),
            prepareRow: (row, indexColumn, indexRow, rectRow) => {
                doc.font("Helvetica").fontSize(9).fillColor('#000000');
                if (indexColumn === 0) {
                    doc.addBackground(rectRow, (indexRow % 2 !== 0 ? '#F2F2F2' : '#FFFFFF'));
                }
            }
        };

        const headBg = '#2F75B5'; // Excel ko'k rang

        // 1. Asosiy KPI
        await doc.table({
            title: "1. Asosiy Ko'rsatkichlar (KPI)",
            headers: [
                { label: "Ko'rsatkich", property: "nomi", width: 215, headerColor: headBg },
                { label: "Foiz (%)", property: "foiz", width: 100, align: "center", headerColor: headBg },
                { label: "Summa (UZS)", property: "summa", width: 200, align: "right", headerColor: headBg }
            ],
            datas: [
                { nomi: "Savdo", foiz: "-", summa: formatPdfNumber(yalpiSavdo) },
                { nomi: "Tannarx", foiz: "-", summa: formatPdfNumber(tannarx) },
                { nomi: "Yalpi Foyda (Daromad)", foiz: formatPdfPercent(yalpiFoiz), summa: formatPdfNumber(yalpiFoyda) },
                { nomi: "Xarajatlar", foiz: "-", summa: formatPdfNumber(xarajatJami) },
                { nomi: "Sof Daromad", foiz: formatPdfPercent(sofFoiz), summa: formatPdfNumber(sofDaromad) },
                { nomi: "Zarar", foiz: "-", summa: formatPdfNumber(zarar) }
            ],
            ...tableStyle
        });
        doc.moveDown();

        // Qolgan jadvallar
        if (cashFlow.length > 0) {
            await doc.table({
                title: "2. Pul Oqimi (Kassalar kesimida)",
                headers: [
                    { label: "Kassa", property: "kassa", width: 115, headerColor: headBg },
                    { label: "Boshlang'ich", property: "bosh", width: 100, align: "right", headerColor: headBg },
                    { label: "Kirim", property: "kirim", width: 100, align: "right", headerColor: headBg },
                    { label: "Chiqim", property: "chiqim", width: 100, align: "right", headerColor: headBg },
                    { label: "Qoldiq", property: "qoldiq", width: 100, align: "right", headerColor: headBg }
                ],
                datas: cashFlow.map(c => ({
                    kassa: c.nomi, 
                    bosh: formatPdfNumber(c.boshlangich), 
                    kirim: formatPdfNumber(c.kirim), 
                    chiqim: formatPdfNumber(c.chiqim), 
                    qoldiq: formatPdfNumber(c.qoldiq)
                })),
                ...tableStyle
            });
            doc.moveDown();
        }

        if (qoldiqlar.length > 0) {
            await doc.table({
                title: "3. Ombor Qoldiqlari (Top 15 qimmat tovarlar)",
                headers: [
                    { label: "Mahsulot", property: "nomi", width: 265, headerColor: headBg },
                    { label: "Qoldiq (Dona)", property: "dona", width: 100, align: "center", headerColor: headBg },
                    { label: "Qoldiq Summasi", property: "summa", width: 150, align: "right", headerColor: headBg }
                ],
                datas: qoldiqlar.map(q => ({
                    nomi: q.nomi, 
                    dona: formatPdfNumber(q.jami_dona), 
                    summa: formatPdfNumber(q.qoldiq_summasi)
                })),
                ...tableStyle
            });
            doc.moveDown();
        }

        if (sellers.length > 0) {
            await doc.table({
                title: "4. Hodimlar Kesimida Sotuv",
                headers: [
                    { label: "Hodim", property: "ism", width: 145, headerColor: headBg },
                    { label: "Chek", property: "chek", width: 70, align: "center", headerColor: headBg },
                    { label: "Savdo", property: "savdo", width: 100, align: "right", headerColor: headBg },
                    { label: "Tannarx", property: "tan", width: 100, align: "right", headerColor: headBg },
                    { label: "Foyda", property: "foyda", width: 100, align: "right", headerColor: headBg }
                ],
                datas: sellers.map(s => ({
                    ism: s.ism || 'Noma\'lum', 
                    chek: String(s.cheklar || 0), 
                    savdo: formatPdfNumber(s.savdo), 
                    tan: formatPdfNumber(s.tannarx),
                    foyda: formatPdfNumber(s.savdo - s.tannarx)
                })),
                ...tableStyle
            });
            doc.moveDown();
        }

        if (products.length > 0) {
            await doc.table({
                title: "5. Top Sotilgan Mahsulotlar",
                headers: [
                    { label: "Mahsulot", property: "nomi", width: 165, headerColor: headBg },
                    { label: "Dona", property: "dona", width: 70, align: "center", headerColor: headBg },
                    { label: "Savdo", property: "savdo", width: 100, align: "right", headerColor: headBg },
                    { label: "Foyda", property: "foyda", width: 100, align: "right", headerColor: headBg },
                    { label: "Marja", property: "marja", width: 80, align: "center", headerColor: headBg }
                ],
                datas: products.map(p => {
                    let foyda = p.savdo - p.tannarx;
                    let marjaPrc = p.tannarx > 0 ? (foyda / p.tannarx) * 100 : 100;
                    return {
                        nomi: p.text || 'Nomsiz', 
                        dona: formatPdfNumber(p.dona), 
                        savdo: formatPdfNumber(p.savdo), 
                        foyda: formatPdfNumber(foyda), 
                        marja: formatPdfPercent(marjaPrc)
                    };
                }),
                ...tableStyle
            });
            doc.moveDown();
        }

        if (ishlabChiqarish.length > 0) {
            await doc.table({
                title: "6. Ishlab Chiqarish Hisoboti",
                headers: [
                    { label: "Hujjat №", property: "doc", width: 70, headerColor: headBg },
                    { label: "Mahsulot", property: "nomi", width: 185, headerColor: headBg },
                    { label: "Sarf (Dona)", property: "sarf", width: 80, align: "center", headerColor: headBg },
                    { label: "Ishlandi (Dona)", property: "ishlandi", width: 80, align: "center", headerColor: headBg },
                    { label: "Summa", property: "summa", width: 100, align: "right", headerColor: headBg }
                ],
                datas: ishlabChiqarish.map(i => ({
                    doc: String(i.hujjat), 
                    nomi: i.mahsulot, 
                    sarf: formatPdfNumber(i.sarf_dona), 
                    ishlandi: formatPdfNumber(i.ishlangan_dona), 
                    summa: formatPdfNumber(i.jami_summa)
                })),
                ...tableStyle
            });
            doc.moveDown();
        }

        if (chiqimlar.length > 0) {
            await doc.table({
                title: "6. Chiqimlar (Xarajatlar kesimida)",
                headers: [
                    { label: "No", property: "no", width: 50, align: "center", headerColor: headBg },
                    { label: "Xarajat Turi", property: "nomi", width: 315, headerColor: headBg },
                    { label: "Summa", property: "summa", width: 150, align: "right", headerColor: headBg }
                ],
                datas: chiqimlar.map((c, i) => ({
                    no: String(i + 1), 
                    nomi: c.kategoriya, 
                    summa: formatPdfNumber(c.jami)
                })),
                ...tableStyle
            });
        }

        doc.end();

        stream.on('finish', () => {
            bot.sendDocument(chatId, filePath, { 
                caption: `📑 <b>${targetDate}</b> kungi professional moliyaviy hisobot tayyor!\n\n<i>✓ Kechagi yopilgan kun uchun hisobot.\n✓ Excel formatidek aniq chiziqlar va tekislashlar bilan.\n✓ O'qishga qulay (zebra) uslubida dizayn qilingan.</i>`, 
                parse_mode: 'HTML' 
            }).then(() => { 
                fs.unlinkSync(filePath); 
            }).catch(err => console.error("Fayl jo'natishda xato:", err)); 
        });

    } catch (err) {
        console.error("PDF Xato:", err);
        bot.sendMessage(chatId, "❌ PDF hisobotni yaratishda xatolik yuz berdi. DB ulanishini tekshiring.");
    }
}

// ==========================================
// 🔍 6. YANGI SAVDOLARNI KUZATISH (BARCHA FOYDALANUVCHILAR UCHUN)
// ==========================================
async function startWatching() {
    try {
        const [rows] = await pool.query('SELECT MAX(id) as maxId FROM qaydnoma');
        lastQaydId = rows[0].maxId || 0;
        console.log(`✅ Baza ulandi! Kuzatuv boshlandi. Oxirgi savdo ID: ${lastQaydId}`);
        setInterval(checkNewSales, 5000);
    } catch (error) {
        console.error("❌ Bazaga ulanish xatosi:", error.message);
    }
}

async function checkNewSales() {
    if (isChecking || lastQaydId === null) return;
    isChecking = true;

    try {
        const [newSales] = await pool.query(`SELECT id FROM qaydnoma WHERE id > ? AND amalTuri = 4 ORDER BY id ASC`, [lastQaydId]);
        for (const sale of newSales) {
            // Barcha qo'shilgan foydalanuvchilarga xabarni jo'natish
            for (const subId of subscribers) {
                try {
                    await sendReceiptDetail(subId, sale.id, null, null, true);
                } catch (e) {
                    console.error(`Xabar yuborilmadi ID: ${subId}`, e.message);
                }
            }
            lastQaydId = sale.id;
        }
    } catch (error) {
        console.error("⚠️ Kuzatuv xatosi:", error.message);
    } finally {
        isChecking = false;
    }
}

process.on('uncaughtException', (err) => console.error("🔥 Kritik xato:", err.message));
process.on('unhandledRejection', (reason) => console.error("🔥 Promise xato:", reason));

startWatching();

// ==========================================
// ⏰ 7. AVTOMATIK KUNLIK HISOBOT (CRON JOB)
// ==========================================
cron.schedule('0 10 * * *', async () => {
    console.log("⏳ Avtomatik PDF hisobot vaqti keldi (10:00)...");
    try {
        for (const subId of subscribers) {
            try {
                await bot.sendMessage(subId, "⏳ 10:00 - Kechagi kun uchun avtomatlashtirilgan PDF hisobot tayyorlanmoqda, kuting...");
                await generateAndSendPDF(subId);
            } catch (e) {
                console.error(`Avtomatik PDF xatosi ID: ${subId}`, e.message);
            }
        }
        console.log("✅ Avtomatik PDF hisobot barchaga muvaffaqiyatli yuborildi.");
    } catch (error) {
        console.error("❌ Avtomatik PDF yuborishda xatolik yuz berdi:", error);
    }
}, {
    scheduled: true,
    timezone: "Asia/Tashkent" 
});

// ==========================================
// ⏰ 8. MAXSUS FOYDALANUVCHI UCHUN /START AVTO-YANGILANISH (HAR 10 DAQIQADA)
// ==========================================
const SPECIFIC_USER_ID = 7868935078; // Siz ko'rsatgan maxsus ID

cron.schedule('*/10 * * * *', async () => {
    try {
        console.log(`⏳ ${SPECIFIC_USER_ID} ID uchun /start komandasi avtomatik tarzda jo'natilmoqda...`);
        addSubscriber(SPECIFIC_USER_ID); 
        
        await bot.sendMessage(
            SPECIFIC_USER_ID, 
            `🟢 <b>Muhasib PRO Boshqaruv Paneli (Avto-yangilanish)</b>\n\nQuyidagi menyulardan foydalaning:`, 
            { parse_mode: 'HTML', ...mainMenu }
        );
        console.log(`✅ ${SPECIFIC_USER_ID} ID ga avtomatik menyu yuborildi.`);
    } catch (error) {
        console.error(`❌ Avtomatik /start xatosi (${SPECIFIC_USER_ID}):`, error.message);
    }
});