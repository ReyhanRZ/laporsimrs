/**
 * ================================================================
 * HELPDESK IT — WhatsApp Bot
 * @whiskeysockets/baileys | Session: ./auth_info | Node.js v20+
 * ================================================================
 * INSTALASI:
 *   npm install @whiskeysockets/baileys @hapi/boom pg express cors multer qrcode-terminal pino node-cache
 *
 * JALANKAN:
 *   node pesan_wa_baileys.js
 *   pm2 start pesan_wa_baileys.js --name pesan-wa
 */

"use strict";

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");

const { Boom } = require("@hapi/boom");
const pino = require("pino");
const { Pool } = require("pg");
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const qrcode = require("qrcode-terminal");
const NodeCache = require("node-cache");

// ================================================================
// Express
// ================================================================
const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization"] }));
app.use((req, res, next) => { if (req.method === "OPTIONS") return res.sendStatus(200); next(); });
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage() });

// ================================================================
// Database
// ================================================================
const pool = new Pool({
  user: "postgres", host: "10.100.1.55",
  database: "wa_bailey", password: "simrs", port: 5432,
});
pool.on("error", err => console.error("[DB] Error:", err.message));
pool.query("SELECT NOW()", (err, res) => {
  if (err) console.error("[DB] Koneksi GAGAL:", err.message);
  else console.log("[DB] Koneksi OK:", res.rows[0].now);
});

// ================================================================
// Konstanta & state global
// ================================================================
const GRUP_NOTIF = "120363427645273225@g.us";
const UPLOAD_DIR = path.join(__dirname, "upload");
const AUTH_DIR = "./auth_info";

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

let sockGlobal = null;   // selalu menunjuk socket terbaru
let pollingTimer = null;   // satu interval saja, tidak numpuk
const albumBuffer = new Map();
const dbCache = {};    // cache kolom DB agar tidak query berulang

// ================================================================
// Helper: normalize nomor → 628xx
// ================================================================
function normalizeNomor(raw) {
  let n = String(raw || "")
    .replace(/@c\.us$|@g\.us$|@lid$|@s\.whatsapp\.net$/g, "")
    .replace(/[^0-9]/g, "");
  if (!n) return "";
  if (n.startsWith("0")) n = "62" + n.slice(1);
  else if (!n.startsWith("62")) n = "62" + n;
  return n;
}

function toJid(nomor) { return normalizeNomor(nomor) + "@s.whatsapp.net"; }
function isGroup(jid) { return typeof jid === "string" && jid.endsWith("@g.us"); }
function isLid(jid) { return typeof jid === "string" && jid.endsWith("@lid"); }

// ================================================================
// Helper: resolve nomor HP dari group metadata via LID
// p.id = LID, p.phoneNumber = nomor HP
// ================================================================
async function resolveNomorDariGrup(sock, grupJid, lidJid) {
  try {
    const meta = await sock.groupMetadata(grupJid);
    if (!Array.isArray(meta?.participants)) return null;

    for (const p of meta.participants) {
      const pId    = p.id || p.jid || '';
      const pPhone = p.phoneNumber || '';

      if (pId === lidJid && pPhone) {
        const nomor = normalizeNomor(pPhone);
        if (nomor && nomor.length >= 10) {
          console.log(`[RESOLVE] ✅ ${lidJid} → ${pPhone} → ${nomor}`);
          return nomor;
        }
      }
    }
    console.warn(`[RESOLVE] ❌ LID ${lidJid} tidak ditemukan di grup ${grupJid}`);
    return null;
  } catch (e) {
    console.warn(`[RESOLVE] Error groupMetadata: ${e.message}`);
    return null;
  }
}

// ================================================================
// Helper: format waktu WIB
// ================================================================
function formatWIB() {
  return new Date().toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

// ================================================================
// Helper: kirim teks — selalu pakai sockGlobal
// ================================================================
async function kirimTeks(jid, teks) {
  if (!sockGlobal) { console.warn("[KIRIM] sock belum ready"); return; }
  await sockGlobal.sendMessage(jid, { text: teks });
}

// ================================================================
// Helper: kirim file — selalu pakai sockGlobal
// ================================================================
async function kirimFile(jid, filePath, caption) {
  if (!sockGlobal) { console.warn("[KIRIM FILE] sock belum ready"); return; }
  const buf = fs.readFileSync(filePath);
  const ext = filePath.split(".").pop().toLowerCase();
  if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) {
    await sockGlobal.sendMessage(jid, { image: buf, caption: caption || "" });
  } else if (["mp4", "3gp", "mov"].includes(ext)) {
    await sockGlobal.sendMessage(jid, { video: buf, caption: caption || "" });
  } else {
    await sockGlobal.sendMessage(jid, {
      document: buf, mimetype: "application/octet-stream",
      fileName: path.basename(filePath), caption: caption || "",
    });
  }
}

// ================================================================
// Helper: resolve JID tujuan dari pesan_masuk
// - Laporan dari GRUP → balas ke JID grup (@g.us)
// - Laporan dari DM   → balas ke JID personal (@s.whatsapp.net / @lid)
// ================================================================
async function getTujuan(idPesan) {
  const { rows } = await pool.query(
    `SELECT nomor_pengirim, chat_id FROM pesan_masuk WHERE id = $1`, [idPesan]
  );
  if (!rows.length) return null;
  const { chat_id, nomor_pengirim } = rows[0];

  // chat_id berisi fromJid asli — bisa grup, personal, atau LID
  if (chat_id && chat_id.includes("@")) return chat_id;

  // nomor_pengirim bisa berisi nomor HP normal atau LID
  if (nomor_pengirim) {
    if (nomor_pengirim.includes("@")) return nomor_pengirim; // sudah JID lengkap (termasuk LID)
    return toJid(nomor_pengirim); // konversi nomor HP → JID
  }

  return null;
}

// ================================================================
// Helper: KIRIM LANGSUNG ke user (tidak lewat antrian)
// Dipanggil saat #proses / #done supaya langsung terkirim
// ================================================================
async function kirimLangsungKeUser(tujuan, teks) {
  if (!sockGlobal) {
    console.warn("[KIRIM LANGSUNG] sock belum ready, masuk antrian saja");
    return false;
  }
  try {
    await sockGlobal.sendMessage(tujuan, { text: teks });
    console.log(`[KIRIM LANGSUNG] ✅ Terkirim ke ${tujuan}`);
    return true;
  } catch (e) {
    console.warn(`[KIRIM LANGSUNG] ⚠ Gagal ke ${tujuan}: ${e.message}`);
    return false;
  }
}

// ================================================================
// Helper: antrikan pesan ke kirim_wa (untuk retry otomatis)
// ================================================================
async function antrikanKirim({ nomor_pengirim, nama_pengirim, isi_pesan, solusi, id_pesan_masuk }) {
  if (dbCache.kirimWaHasSolusi === undefined) {
    const r = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name='kirim_wa' AND column_name='solusi' LIMIT 1`
    );
    dbCache.kirimWaHasSolusi = r.rows.length > 0;
  }
  if (dbCache.kirimWaHasSolusi) {
    await pool.query(
      `INSERT INTO kirim_wa (nomor_pengirim,nama_pengirim,isi_pesan,solusi,tg_kirim,status_kirim,id_pesan_masuk)
       VALUES ($1,$2,$3,$4,LOCALTIMESTAMP(0),0,$5)`,
      [nomor_pengirim, nama_pengirim || null, isi_pesan, solusi || null, id_pesan_masuk || null]
    );
  } else {
    await pool.query(
      `INSERT INTO kirim_wa (nomor_pengirim,nama_pengirim,isi_pesan,tg_kirim,status_kirim,id_pesan_masuk)
       VALUES ($1,$2,$3,LOCALTIMESTAMP(0),0,$4)`,
      [nomor_pengirim, nama_pengirim || null, isi_pesan, id_pesan_masuk || null]
    );
  }
  console.log(`[ANTRIAN] ✅ Pesan ke ${nomor_pengirim} masuk antrian`);
}

// ================================================================
// Helper: upsert pengguna
// ================================================================
async function upsertPengguna(nomorHP, namaUser, lid) {
  try {
    let row = null;
    let foundBy = null; // "lid" atau "nomor"

    // Cari dulu via LID
    if (lid) {
      const r = await pool.query(
        `SELECT kd_unit, nomor_hp, whatsapp_lid FROM pengguna WHERE whatsapp_lid=$1 LIMIT 1`, [lid]
      );
      if (r.rows.length) { row = r.rows[0]; foundBy = "lid"; }
    }

    // Jika tidak ketemu via LID, cari via nomor HP
    if (!row && nomorHP) {
      const r = await pool.query(
        `SELECT kd_unit, nomor_hp, whatsapp_lid FROM pengguna WHERE nomor_hp=$1 LIMIT 1`, [nomorHP]
      );
      if (r.rows.length) { row = r.rows[0]; foundBy = "nomor"; }
    }

    if (row) {
      // Kumpulkan field yang perlu diupdate
      const updates = [];
      const params = [];
      let idx = 1;

      // Update nomor_hp jika masih kosong atau berbeda
      if (nomorHP && (!row.nomor_hp || row.nomor_hp !== nomorHP)) {
        updates.push(`nomor_hp=$${idx++}`);
        params.push(nomorHP);
        console.log(`[USER] nomor_hp: "${row.nomor_hp || "(kosong)"}" → "${nomorHP}"`);
      }

      // Update whatsapp_lid jika masih kosong atau berbeda
      if (lid && (!row.whatsapp_lid || row.whatsapp_lid !== lid)) {
        updates.push(`whatsapp_lid=$${idx++}`);
        params.push(lid);
        console.log(`[USER] whatsapp_lid: "${row.whatsapp_lid || "(kosong)"}" → "${lid}"`);
      }

      // Selalu update nama
      updates.push(`nama_user=$${idx++}`);
      params.push(namaUser);

      if (updates.length > 0) {
        // WHERE: gunakan identifier yang pasti ada (yang kita gunakan untuk menemukan row)
        let whereClause;
        if (foundBy === "lid") {
          whereClause = `whatsapp_lid=$${idx}`;
          params.push(lid);
        } else {
          whereClause = `nomor_hp=$${idx}`;
          params.push(row.nomor_hp);
        }

        const q = `UPDATE pengguna SET ${updates.join(", ")} WHERE ${whereClause} RETURNING nomor_hp, whatsapp_lid`;
        const res = await pool.query(q, params);
        console.log(`[USER] ✅ Update (foundBy=${foundBy}):`, res.rows[0]);
      }

      return { kdUnit: row.kd_unit };
    }

    // ── Belum ada di DB → Insert baru ─────────────────────────
    if (nomorHP) {
      // Ada nomor HP → insert dengan nomor sebagai anchor, upsert jika conflict
      const ins = await pool.query(
        `INSERT INTO pengguna (nama_user, nomor_hp, whatsapp_lid, kd_unit)
         VALUES ($1, $2, $3, NULL)
         ON CONFLICT (nomor_hp) DO UPDATE
           SET whatsapp_lid = COALESCE(EXCLUDED.whatsapp_lid, pengguna.whatsapp_lid),
               nama_user    = EXCLUDED.nama_user
         RETURNING nomor_hp, whatsapp_lid`,
        [namaUser, nomorHP, lid || null]
      );
      console.log(`[USER] ✅ Insert baru (by nomor):`, ins.rows[0]);
    } else if (lid) {
      // Hanya ada LID → insert tanpa nomor HP, hindari duplicate LID
      const ins = await pool.query(
        `INSERT INTO pengguna (nama_user, nomor_hp, whatsapp_lid, kd_unit)
         VALUES ($1, NULL, $2, NULL)
         ON CONFLICT (whatsapp_lid) DO UPDATE
           SET nama_user = EXCLUDED.nama_user
         RETURNING nomor_hp, whatsapp_lid`,
        [namaUser, lid]
      );
      console.log(`[USER] ✅ Insert baru (by LID):`, ins.rows[0]);
    }

    return { kdUnit: null };

  } catch (e) {
    console.error("[USER] error:", e.message);
    return { kdUnit: null };
  }
}

// ================================================================
// Helper: deteksi unit & divisi dari teks laporan
// ================================================================
// async function deteksiUnit(teks) {
//   try {
//     const { rows } = await pool.query(`SELECT kd_unit, nama_unit FROM unit`);
//     const lc = teks.toLowerCase();
//     const sorted = rows.filter(r => r.nama_unit).sort((a, b) => b.nama_unit.length - a.nama_unit.length);
//     for (const r of sorted) {
//       if (new RegExp(`\\b${r.nama_unit.toLowerCase()}\\b`, "i").test(lc)) return r.kd_unit;
//     }
//     return null;
//   } catch { return null; }
// }

async function deteksiUnit(teks) {
  try {
    const { rows } = await pool.query(`SELECT kd_unit, nama_unit FROM unit`);
    const lc = teks.toLowerCase().trim();
    console.log(`[UNIT] Mencari unit dari teks: "${lc}"`);
    // console.log(`[UNIT] Daftar unit di DB:`, rows.map(r => r.nama_unit));
    const sorted = rows
      .filter(r => r.nama_unit && r.nama_unit.trim())
      .sort((a, b) => b.nama_unit.length - a.nama_unit.length);
    for (const r of sorted) {
      const keyword = r.nama_unit.toLowerCase().trim();
      if (lc.includes(keyword)) {
        console.log(`[UNIT] ✅ Cocok: "${keyword}" → kd_unit=${r.kd_unit}`);
        return r.kd_unit;
      }
    }
    console.log(`[UNIT] ❌ Tidak ada unit yang cocok`);
    return null;
  } catch (e) {
    console.error(`[UNIT] Error:`, e.message);
    return null;
  }
}

async function deteksiDivisi(teks) {
  try {
    const { rows } = await pool.query(
      `SELECT kd_divisi, keyword FROM keyword_divisi ORDER BY LENGTH(keyword) DESC`
    );
    const lc = teks.toLowerCase();
    for (const r of rows) {
      if (lc.includes(r.keyword.toLowerCase())) return r.kd_divisi;
    }
    return null;
  } catch { return null; }
}

async function getNamaDivisi(kdDivisi) {
  if (!kdDivisi) return "Tidak Terdeteksi";
  try {
    const r = await pool.query(`SELECT name FROM divisi WHERE kd_divisi=$1`, [kdDivisi]);
    return r.rows[0]?.name || "Tidak Terdeteksi";
  } catch { return "Tidak Terdeteksi"; }
}

// ================================================================
// Cek & siapkan kolom tabel
// ================================================================
async function cekStrukturTabel() {
  // pesan_masuk
  let cols = [];
  try {
    const r = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='pesan_masuk'`);
    cols = r.rows.map(x => x.column_name);
    console.log("[DB] Kolom pesan_masuk:", cols.join(", "));
  } catch (e) { console.error("[DB] Gagal baca kolom:", e.message); }

  for (const { col, def } of [
    { col: "attachments", def: "TEXT[] DEFAULT '{}'" },
    { col: "kd_divisi", def: "INT4 REFERENCES divisi(kd_divisi)" },
    { col: "chat_id", def: "VARCHAR" },
    { col: "status_hapus", def: "INT2 DEFAULT 0" },
  ]) {
    if (!cols.includes(col)) {
      try { await pool.query(`ALTER TABLE pesan_masuk ADD COLUMN ${col} ${def}`); console.log(`[DB] +${col}`); }
      catch (e) { console.warn(`[DB] pesan_masuk.${col}:`, e.message); }
    }
  }
  dbCache.colWaktu = cols.includes("tgl_lapor") ? "tgl_lapor" : "timestamp";
  console.log("[DB] Kolom waktu:", dbCache.colWaktu);

  // kirim_wa
  let cols2 = [];
  try {
    const r2 = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='kirim_wa'`);
    cols2 = r2.rows.map(x => x.column_name);
  } catch (e) { console.error("[DB] Gagal baca kolom kirim_wa:", e.message); }

  for (const { col, def } of [
    { col: "nama_pengirim", def: "VARCHAR" },
    { col: "id_pesan_masuk", def: "INT4" },
    { col: "solusi", def: "TEXT" },
    { col: "retry_count", def: "INT2 DEFAULT 0" },
  ]) {
    if (!cols2.includes(col)) {
      try { await pool.query(`ALTER TABLE kirim_wa ADD COLUMN ${col} ${def}`); console.log(`[DB] +${col}`); }
      catch (e) { console.warn(`[DB] kirim_wa.${col}:`, e.message); }
    }
  }
}

// ================================================================
// Download & simpan media ke disk
// ================================================================
async function simpanMedia(msg, idSuffix) {
  if (!sockGlobal) return null;
  try {
    const msgType = Object.keys(msg.message || {})[0];
    const buf = await downloadMediaMessage(msg, "buffer", {}, {
      logger: pino({ level: "silent" }),
      reuploadRequest: sockGlobal.updateMediaMessage,
    });
    if (!buf) return null;
    const mime = msg.message?.[msgType]?.mimetype || "application/octet-stream";
    const extMap = {
      "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
      "video/mp4": "mp4", "video/3gpp": "3gp", "video/quicktime": "mov",
      "audio/ogg": "ogg", "audio/mpeg": "mp3", "application/pdf": "pdf",
    };
    const ext = extMap[mime.split(";")[0]] || mime.split("/")[1] || "bin";
    const name = `${Date.now()}_${String(idSuffix).slice(-8)}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
    console.log(`[MEDIA] Simpan: upload/${name}`);
    return `upload/${name}`;
  } catch (e) {
    console.error("[MEDIA] Gagal:", e.message);
    return null;
  }
}

// ================================================================
// Handler: #proses<id>
// Kirim notif ke user LANGSUNG + antrian (fallback jika gagal)
// ================================================================
async function handleProses(msg, idPesan, senderJid) {
  console.log(`[PROSES] #proses${idPesan} dari ${senderJid}`);
  const replyTo = msg.key.remoteJid;
  try {
    const { rows } = await pool.query(
      `SELECT id, pengirim, nomor_pengirim, chat_id FROM pesan_masuk WHERE id=$1`, [idPesan]
    );
    if (!rows.length) { await kirimTeks(replyTo, `❌ Laporan #${idPesan} tidak ditemukan.`); return; }

    const lap = rows[0];
    const namaPemberi = msg.pushName || senderJid;
    const pesanUser = `Halo *${lap.pengirim}*, laporan Anda *sedang kami proses*. Kami akan segera menindaklanjuti. 🔧`;
    const pesanGrup = `🔄 *UPDATE* — Laporan *#${idPesan}*\n👤 ${lap.pengirim}\n→ Status: *DIPROSES* oleh *${namaPemberi}*`;

    // Update DB
    await pool.query(
      `UPDATE pesan_masuk SET status_selesai=1, tgl_proses=LOCALTIMESTAMP(0) WHERE id=$1`, [idPesan]
    );

    // Resolve tujuan user
    const tujuan = await getTujuan(idPesan);
    if (!tujuan) {
      console.warn(`[PROSES] Tujuan tidak ditemukan untuk #${idPesan}`);
      await kirimTeks(replyTo, `⚠️ Laporan #${idPesan} diproses, tapi tujuan user tidak ditemukan.`);
    } else {
      // Kirim langsung ke user
      const berhasil = await kirimLangsungKeUser(tujuan, pesanUser);

      // Jika gagal langsung, masukkan antrian agar dicoba ulang
      if (!berhasil) {
        await antrikanKirim({
          nomor_pengirim: tujuan,
          nama_pengirim: namaPemberi,
          isi_pesan: pesanUser,
          id_pesan_masuk: idPesan,
        });
      }
    }

    // Notif ke grup
    await kirimTeks(GRUP_NOTIF, pesanGrup).catch(e => console.warn("[GRUP] proses:", e.message));
    console.log(`[PROSES] ✅ ID ${idPesan}`);
  } catch (err) {
    console.error("[PROSES] Error:", err.message);
    await kirimTeks(replyTo, `❌ Gagal: ${err.message}`);
  }
}

// ================================================================
// Handler: #done<id> [solusi]
// Kirim notif ke user LANGSUNG + antrian (fallback jika gagal)
// ================================================================
async function handleDone(msg, idPesan, pesanSolusi, senderJid) {
  console.log(`[DONE] #done${idPesan} dari ${senderJid}`);
  const replyTo = msg.key.remoteJid;
  try {
    const { rows } = await pool.query(
      `SELECT id, pengirim, nomor_pengirim, chat_id FROM pesan_masuk WHERE id=$1`, [idPesan]
    );
    if (!rows.length) { await kirimTeks(replyTo, `❌ Laporan #${idPesan} tidak ditemukan.`); return; }

    const lap = rows[0];
    const namaPemberi = msg.pushName || senderJid;
    const pesanUser = `Halo *${lap.pengirim}*, laporan Anda telah *diselesaikan*. Terima kasih sudah melapor. 🙏`;
    const pesanGrup = `✅ *UPDATE* — Laporan *#${idPesan}*\n👤 ${lap.pengirim}\n→ Status: *SELESAI* oleh *${namaPemberi}*` +
      (pesanSolusi ? `\n📝 Solusi: _${pesanSolusi}_` : "");

    // Update DB
    await pool.query(
      `UPDATE pesan_masuk SET status_selesai=2, tgl_selesai=LOCALTIMESTAMP(0) WHERE id=$1`, [idPesan]
    );

    // Resolve tujuan user
    const tujuan = await getTujuan(idPesan);
    if (!tujuan) {
      console.warn(`[DONE] Tujuan tidak ditemukan untuk #${idPesan}`);
      await kirimTeks(replyTo, `⚠️ Laporan #${idPesan} selesai, tapi tujuan user tidak ditemukan.`);
    } else {
      // Kirim langsung ke user
      const berhasil = await kirimLangsungKeUser(tujuan, pesanUser);

      // Jika gagal langsung, masukkan antrian agar dicoba ulang
      if (!berhasil) {
        await antrikanKirim({
          nomor_pengirim: tujuan,
          nama_pengirim: namaPemberi,
          isi_pesan: pesanUser,
          solusi: pesanSolusi,
          id_pesan_masuk: idPesan,
        });
      }
    }

    // Notif ke grup
    await kirimTeks(GRUP_NOTIF, pesanGrup).catch(e => console.warn("[GRUP] done:", e.message));
    console.log(`[DONE] ✅ ID ${idPesan}`);
  } catch (err) {
    console.error("[DONE] Error:", err.message);
    await kirimTeks(replyTo, `❌ Gagal: ${err.message}`);
  }
}

// ================================================================
// Handler: #lapor — masukkan ke buffer (grouping album foto)
// ================================================================
async function handleLaporBuffer(msg, combined, senderJid, fromJid) {
  const msgType = Object.keys(msg.message || {})[0];
  const isMediaMsg = ["imageMessage", "videoMessage", "documentMessage", "audioMessage"].includes(msgType);
  const groupedId = msg.message?.imageMessage?.contextInfo?.groupedId
    || msg.message?.videoMessage?.contextInfo?.groupedId;
  const tsBucket = Math.floor((msg.messageTimestamp || Date.now() / 1000) / 10);

  let senderKey;
  if (groupedId) senderKey = `${senderJid}_album_${groupedId}`;
  else if (isMediaMsg) senderKey = `${senderJid}_media_${tsBucket}`;
  else senderKey = `${senderJid}_text_${msg.key.id}`;

  let buf = albumBuffer.get(senderKey);
  if (!buf) {
    buf = { files: [], messages: [], timer: null, processed: false, combined, fromJid };
    albumBuffer.set(senderKey, buf);
  }
  buf.messages.push(msg);
  if (combined && combined.length > (buf.combined || "").length) buf.combined = combined;

  if (isMediaMsg) {
    const file = await simpanMedia(msg, msg.key.id + "_" + Date.now()).catch(e => {
      console.error("[DOWNLOAD]", e.message); return null;
    });
    if (file) { buf.files.push(file); console.log("[FILE] total:", buf.files.length); }
  }

  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => prosesLaporan(senderKey), 5000);
  albumBuffer.set(senderKey, buf);
}

// ================================================================
// Proses laporan dari buffer — kirim notif ke GRUP
// ================================================================
async function prosesLaporan(senderKey) {
  if (!albumBuffer.has(senderKey)) return;
  const buf = albumBuffer.get(senderKey);
  if (!buf || buf.processed) return;
  buf.processed = true;
  albumBuffer.delete(senderKey);

  const { messages, files } = buf;
  if (files.length > 10) files.splice(10);

  try {
    const msg = messages[0];
    const fromJid = buf.fromJid || msg.key.remoteJid;

    // ── Resolve nomor pengirim ─────────────────────────────────
    let nomorUser = null;
    let lidValue = null;

    if (isGroup(fromJid)) {
  const participant = typeof (msg.key.participant || '') === 'string'
    ? (msg.key.participant || '')
    : (msg.key.participant?.id || msg.key.participant?.jid || '');

  const participantAlt = typeof (msg.key.participantAlt || '') === 'string'
    ? (msg.key.participantAlt || '')
    : (msg.key.participantAlt?.id || msg.key.participantAlt?.jid || '');

  console.log(`[NOMOR] participant=${participant} participantAlt=${participantAlt}`);

  if (participantAlt.endsWith("@s.whatsapp.net") || participantAlt.endsWith("@c.us")) {
    // Kasus 1: Baileys sediakan nomor via participantAlt
    nomorUser = normalizeNomor(participantAlt);
    lidValue  = participant.endsWith("@lid") ? participant : null;
    console.log(`[NOMOR] ✅ dari participantAlt: ${nomorUser}`);

  } else if (participant.endsWith("@s.whatsapp.net") || participant.endsWith("@c.us")) {
    // Kasus 2: participant langsung berisi nomor HP
    nomorUser = normalizeNomor(participant);
    console.log(`[NOMOR] ✅ dari participant: ${nomorUser}`);

  } else if (participant.endsWith("@lid")) {
    // Kasus 3: LID — resolve dari groupMetadata dulu, fallback ke DB
    lidValue = participant;

     // LOG TAMBAHAN — lihat apakah resolve berhasil
    console.log(`[DEBUG] Mencoba resolve LID: ${lidValue} dari grup: ${fromJid}`);

    // Prioritas 1: groupMetadata (p.phoneNumber)
    nomorUser = await resolveNomorDariGrup(sockGlobal, fromJid, lidValue);

    // Prioritas 2: fallback DB
    if (!nomorUser) {
      const cekDb = await pool.query(
        `SELECT nomor_hp FROM pengguna
         WHERE whatsapp_lid=$1 AND nomor_hp IS NOT NULL AND nomor_hp != '' AND LENGTH(nomor_hp) >= 10
         LIMIT 1`,
        [lidValue]
      );
      if (cekDb.rows.length) {
        nomorUser = cekDb.rows[0].nomor_hp;
        console.log(`[LID] ✅ dari DB: ${lidValue} → ${nomorUser}`);
      } else {
        console.warn(`[LID] ❌ Tidak bisa resolve nomor: ${lidValue}`);
      }
    }
  }

  // Simpan mapping LID → nomor jika berhasil dapat keduanya
  if (nomorUser && lidValue) {
    pool.query(
      `UPDATE pengguna SET nomor_hp=$1
       WHERE whatsapp_lid=$2 AND (nomor_hp IS NULL OR nomor_hp = '' OR LENGTH(nomor_hp) < 10)`,
      [nomorUser, lidValue]
    ).catch(() => {});
  }
}

    else if (isLid(fromJid)) {
       // DM via LID
  lidValue = fromJid;

  // LOG SEMENTARA — dump seluruh msg.key untuk lihat field yang tersedia
  console.log(`[LID DM DEBUG] msg.key:`, JSON.stringify(msg.key, null, 2));
  console.log(`[LID DM DEBUG] msg.verifiedBizName:`, msg.verifiedBizName);
  console.log(`[LID DM DEBUG] participant:`, msg.participant);
  console.log(`[LID DM DEBUG] pushName:`, msg.pushName);
  
  // Prioritas 1: cek DB dulu
  const cekDb = await pool.query(
    `SELECT nomor_hp FROM pengguna
     WHERE whatsapp_lid=$1 AND nomor_hp IS NOT NULL AND nomor_hp != '' AND LENGTH(nomor_hp) >= 10
     LIMIT 1`,
    [lidValue]
  );
  if (cekDb.rows.length) {
    nomorUser = cekDb.rows[0].nomor_hp;
    console.log(`[LID DM] ✅ DB: ${lidValue} → ${nomorUser}`);
  } else {
    // Prioritas 2: coba resolve dari semua grup yang diikuti bot
    console.log(`[LID DM] Tidak di DB, coba resolve dari grup...`);
    try {
      const semuaGrup = await sockGlobal.groupFetchAllParticipating();
      for (const grupJid of Object.keys(semuaGrup)) {
        const nomor = await resolveNomorDariGrup(sockGlobal, grupJid, lidValue);
        if (nomor) {
          nomorUser = nomor;
          console.log(`[LID DM] ✅ Resolve dari grup ${grupJid}: ${nomorUser}`);
          // Langsung simpan ke DB supaya berikutnya tidak perlu resolve lagi
          await pool.query(
            `UPDATE pengguna SET nomor_hp=$1
             WHERE whatsapp_lid=$2 AND (nomor_hp IS NULL OR nomor_hp = '' OR LENGTH(nomor_hp) < 10)`,
            [nomorUser, lidValue]
          ).catch(() => {});
          break;
        }
      }
    } catch (e) {
      console.warn(`[LID DM] Gagal resolve dari grup: ${e.message}`);
    }

    if (!nomorUser) {
      console.warn(`[LID DM] ❌ Tidak bisa resolve nomor untuk: ${lidValue}`);
    }
  }
    } else {
      // DM normal @s.whatsapp.net
      nomorUser = normalizeNomor(fromJid);
    }
    // Validasi
    // if ((!nomorUser || nomorUser.length < 8) && !lidValue) {
    //   console.warn("[VALIDASI] Nomor tidak valid dan tidak ada LID, skip.");
    //   return;
    // }

    if (!nomorUser && !lidValue) {
      console.warn("[VALIDASI] Tidak ada nomor maupun LID, skip.");
      return;
    }

    // Kalau nomor kosong tapi ada LID, pakai LID sebagai nomor sementara
    if (!nomorUser && lidValue) {
      nomorUser = null; // biarkan null, simpan LID di chat_id
      console.warn("[VALIDASI] Nomor tidak tersedia, laporan tetap masuk dengan LID.");
    }

    const namaUser = msg.pushName || nomorUser || "Unknown";

    // Kumpulkan semua teks
    const semuaText = [];
    // for (const m of messages) {
    //   const t = Object.keys(m.message || {})[0];
    //   const b = m.message?.[t]?.caption || m.message?.conversation || "";
    //   if (b.trim()) semuaText.push(b.trim());
    // }
    for (const m of messages) {
      const t = Object.keys(m.message || {})[0];
      const b =
        m.message?.conversation ||
        m.message?.extendedTextMessage?.text ||
        m.message?.[t]?.caption || "";
      if (b.trim()) semuaText.push(b.trim());
    }
    // const pesanBersih = [...new Set(semuaText)].join(" ").replace(/#lapor/gi, "").trim() || "(tanpa isi)";
    const pesanBersih = [...new Set(semuaText)]
      .join(" ")
      .replace(/#lapor[,\s]*/gi, "")  // hapus #lapor beserta koma/spasi setelahnya
      .trim() || "(tanpa isi)";


    // Upsert pengguna dulu
    const { kdUnit: kdUnitLama } = await upsertPengguna(nomorUser, namaUser, lidValue);

    // Nama unit dari DB (kd_unit lama)
    let namaUnitFinal = null;
    if (kdUnitLama) {
      const ur = await pool.query(
        `SELECT nama_unit FROM unit WHERE kd_unit=$1`, [kdUnitLama]
      ).catch(() => ({ rows: [] }));
      namaUnitFinal = ur.rows[0]?.nama_unit || null;
    }

    let kdUnitDeteksi = null;
    try {
      kdUnitDeteksi = await deteksiUnit(pesanBersih);
    } catch (e) {
      console.warn("[UNIT] deteksiUnit error:", e.message);
    }

    console.log(`[UNIT] kdUnitDeteksi=${kdUnitDeteksi}, nomorUser=${nomorUser}, lidValue=${lidValue}`);


    // const kdUnitDeteksi = await deteksiUnit(pesanBersih);
    if (kdUnitDeteksi) {
      try {
        let updateResult;
        if (nomorUser) {
          updateResult = await pool.query(
            `UPDATE pengguna SET kd_unit=$1 WHERE nomor_hp=$2 RETURNING kd_unit, nama_user`,
            [kdUnitDeteksi, nomorUser]
          );
        } else if (lidValue) {
          updateResult = await pool.query(
            `UPDATE pengguna SET kd_unit=$1 WHERE whatsapp_lid=$2 RETURNING kd_unit, nama_user`,
            [kdUnitDeteksi, lidValue]
          );
        }

        if (updateResult?.rowCount > 0) {
          console.log(`[UNIT] ✅ DB updated:`, updateResult.rows[0]);
        } else {
          console.warn(`[UNIT] ⚠ Tidak ada row terupdate! nomorUser=${nomorUser} lidValue=${lidValue}`);
          const cekUser = await pool.query(
            `SELECT nomor_hp, whatsapp_lid, kd_unit FROM pengguna WHERE nomor_hp=$1 OR whatsapp_lid=$2`,
            [nomorUser || null, lidValue || null]
          );
          console.log(`[UNIT] Data pengguna di DB:`, cekUser.rows);
        }

        const ur = await pool.query(`SELECT nama_unit FROM unit WHERE kd_unit=$1`, [kdUnitDeteksi]);
        namaUnitFinal = ur.rows[0]?.nama_unit || namaUnitFinal;
        console.log(`[UNIT] namaUnitFinal: ${namaUnitFinal}`);
      } catch (e) {
        console.warn("[UNIT] Gagal update:", e.message);
      }
    }

    const kdDivisi = await deteksiDivisi(pesanBersih);
    const namaDivisi = await getNamaDivisi(kdDivisi);
    const colWaktu = dbCache.colWaktu || "timestamp";
    // chat_id: simpan JID GRUP jika dari grup, JID personal jika DM
    // Tujuan: saat #proses/#done, balasan dikirim ke tempat yang sama
    const chatIdAsal = fromJid;  // fromJid = grup JID (@g.us) atau personal JID (@s.whatsapp.net/@lid)
    const msgId = msg.key.id;

    console.log(`[LAPOR] ${namaUser} | ${nomorUser || "-"} | LID:${lidValue || "-"} | Unit:${namaUnitFinal || "-"} | File:${files.length} | "${pesanBersih}"`);

    // Insert ke DB
    const dbRes = await pool.query(
      `INSERT INTO pesan_masuk (nomor_pengirim,pengirim,isi_pesan,whatsapp_id,${colWaktu},attachments,kd_divisi,chat_id,status_hapus)
       VALUES ($1,$2,$3,$4,LOCALTIMESTAMP(0),$5,$6,$7,0)
       ON CONFLICT (whatsapp_id) DO NOTHING RETURNING id`,
      [nomorUser || lidValue || "unknown", namaUser, pesanBersih, msgId, files, kdDivisi, chatIdAsal]
    );

    if (dbRes.rowCount === 0) { console.log("[SKIP] Duplicate:", msgId); return; }
    const idBaru = dbRes.rows[0].id;

    // Notif ke grup
    const notif =
      `🔔 *LAPORAN MASUK* — ID *#${idBaru}*\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `👤 *Nama    :* ${namaUser}\n` +
      (namaUnitFinal ? `🏥 *Ruangan :* ${namaUnitFinal}\n` : "") +
      `📱 *Nomor   :* ${nomorUser || "(LID - belum terdeteksi)"}\n` +
      `🕐 *Pukul   :* ${formatWIB()}\n` +
      `🏷️ *Divisi  :* ${namaDivisi}\n` +
      `📝 *Isi     :*\n${pesanBersih}\n` +
      (files.length ? `📎 *Lampiran:* ${files.length} file\n` : "") +
      `━━━━━━━━━━━━━━━━━\n` +
      `💬 Balas dengan:\n` +
      `• *#proses${idBaru}* → tandai diproses\n` +
      `• *#done${idBaru}* [solusi] → tandai selesai`;

    try {
      await sockGlobal.sendMessage(GRUP_NOTIF, { text: notif });
      console.log(`[GRUP] ✅ Notif #${idBaru} terkirim`);
      // ── Auto-reply ke pengirim ─────────────────────────────────
try {
  let replyTarget = null;

  if (isGroup(fromJid)) {
    // Dari grup → balas ke grup itu langsung
    replyTarget = fromJid;
  } else if (nomorUser) {
    // DM dengan nomor HP normal
    replyTarget = toJid(nomorUser);
  } else if (lidValue) {
    // DM via LID — kirim langsung ke LID
    replyTarget = lidValue;
  }

  if (replyTarget) {
    const pesanAck =
      `✅ Halo *${namaUser}*, laporan Anda telah masuk ke sistem ticketing kami.\n\n` +
      `🎫 *ID Tiket :* #${idBaru}\n` +
      (namaUnitFinal ? `🏥 *Unit     :* ${namaUnitFinal}\n` : "") +
      `🕐 *Waktu    :* ${formatWIB()}\n\n` +
      `Tim kami akan segera menindaklanjuti. Terima kasih! 🙏`;

    await sockGlobal.sendMessage(replyTarget, { text: pesanAck });
    console.log(`[ACK] ✅ Auto-reply terkirim ke ${replyTarget}`);
  } else {
    console.warn(`[ACK] ⚠ Tidak ada target valid (nomorUser=${nomorUser}, lidValue=${lidValue})`);
  }
} catch (e) {
  console.warn(`[ACK] ⚠ Gagal kirim auto-reply: ${e.message}`);
}
    } catch (e) {
      console.error("[GRUP] ❌ Gagal kirim notif:", e.message);
    }

    // Kirim lampiran ke grup
    for (let i = 0; i < files.length; i++) {
      await kirimFile(GRUP_NOTIF, path.join(__dirname, files[i]), `📎 ${i + 1}/${files.length} — #${idBaru}`)
        .catch(e => console.error("[KIRIM FILE]", e.message));
    }

    console.log(`[OK] Laporan #${idBaru} selesai diproses | ${files.length} file`);
  } catch (err) {
    console.error("========== ERROR prosesLaporan ==========");
    console.error("msg  :", err.message);
    console.error("stack:", err.stack);
    console.error("=========================================");
  }
}

// ================================================================
// POLLING kirim_wa — fallback retry untuk pesan yang gagal terkirim
// Berjalan setiap 5 detik. Satu interval saja (tidak numpuk).
// ================================================================
async function prosesAntrianKirim() {
  if (!sockGlobal) { console.log("[POLLING] WA belum ready, skip."); return; }
  try {
    const { rows } = await pool.query(`
      SELECT id_kirim, nomor_pengirim, isi_pesan, COALESCE(retry_count,0) AS retry_count
      FROM kirim_wa WHERE status_kirim=0 ORDER BY tg_kirim ASC LIMIT 5
    `);
    for (const row of rows) {
      const raw = String(row.nomor_pengirim).trim();
      let jid;
      if (raw.endsWith("@g.us")) jid = raw;
      else if (raw.endsWith("@s.whatsapp.net")) jid = raw;
      else if (raw.endsWith("@c.us")) jid = raw.replace("@c.us", "@s.whatsapp.net");
      else if (raw.endsWith("@lid")) jid = raw; // kirim langsung ke LID
      else jid = toJid(raw);

      try {
        console.log(`[POLLING] → ${jid} (id:${row.id_kirim} retry:${row.retry_count})`);
        await sockGlobal.sendMessage(jid, { text: row.isi_pesan });
        await pool.query(`UPDATE kirim_wa SET status_kirim=1 WHERE id_kirim=$1`, [row.id_kirim]);
        console.log(`[POLLING] ✅ Terkirim`);
      } catch (sendErr) {
        console.warn(`[POLLING] ⚠ Gagal: ${sendErr.message}`);
        const retry = (row.retry_count || 0) + 1;
        if (retry >= 10) {
          await pool.query(`UPDATE kirim_wa SET status_kirim=2 WHERE id_kirim=$1`, [row.id_kirim]);
          console.error(`[POLLING] ❌ Permanen gagal setelah ${retry}x`);
        } else {
          await pool.query(`UPDATE kirim_wa SET retry_count=$1 WHERE id_kirim=$2`, [retry, row.id_kirim]).catch(() => { });
        }
      }
    }
  } catch (err) {
    if (err.message && !err.message.includes("kirim_wa")) console.error("[POLLING]", err.message);
  }
}

// ================================================================
// Auto-update nomor_pengirim di pesan_masuk yang masih berformat LID
// Jalan setiap 30 detik
// ================================================================
async function syncNomorDariLid() {
  try {
    // Ambil semua pesan_masuk yang nomornya masih berformat LID
    const { rows } = await pool.query(`
      SELECT id, nomor_pengirim
      FROM pesan_masuk
      WHERE nomor_pengirim LIKE '%@lid'
         OR (nomor_pengirim ~ '^[0-9]{10,}$' AND LENGTH(nomor_pengirim) > 15)
      LIMIT 50
    `);

    if (!rows.length) return;
    console.log(`[SYNC LID] Ditemukan ${rows.length} pesan dengan nomor LID`);

    for (const row of rows) {
      // Cari di tabel pengguna berdasarkan whatsapp_lid
      const cek = await pool.query(
        `SELECT nomor_hp FROM pengguna
         WHERE whatsapp_lid = $1
           AND nomor_hp IS NOT NULL
           AND nomor_hp != ''
         LIMIT 1`,
        [row.nomor_pengirim]
      );

      if (cek.rows.length && cek.rows[0].nomor_hp) {
        const nomorBaru = cek.rows[0].nomor_hp;
        await pool.query(
          `UPDATE pesan_masuk SET nomor_pengirim = $1 WHERE id = $2`,
          [nomorBaru, row.id]
        );
        console.log(`[SYNC LID] ✅ ID #${row.id}: ${row.nomor_pengirim} → ${nomorBaru}`);
      }
    }
  } catch (e) {
    console.error("[SYNC LID] Error:", e.message);
  }
}

// ================================================================
// Inisialisasi Baileys
// ================================================================
async function startSock() {
  await cekStrukturTabel();

  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  console.log("[WA] Baileys version:", version.join("."));

  const groupCache = new NodeCache({ stdTTL: 5 * 60, useClones: false });

  const sock = makeWASocket({
    version,
    logger: pino({ level: "warn" }),
    auth: state,
    browser: ["Helpdesk IT", "Chrome", "120.0.0"],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    retryRequestDelayMs: 250,
    maxMsgRetryCount: 5,
    // cachedGroupMetadata: async (jid) => {
    //   const hit = groupCache.get(jid);
    //   if (hit) return hit;
    //   try {
    //     const meta = await sock.groupMetadata(jid);
    //     groupCache.set(jid, meta);
    //     return meta;
    //   } catch { return undefined; }
    // },
    cachedGroupMetadata: async (jid) => {
      const hit = groupCache.get(jid);
      if (hit) return hit;
      try {
        const meta = await sock.groupMetadata(jid);
        // Normalize: participants harus array of { id: string, ... }
        // Baileys internal kadang expect .id bukan raw string
        if (Array.isArray(meta?.participants)) {
          meta.participants = meta.participants.map(p => {
            if (typeof p === 'string') return { id: p };
            if (p && typeof p === 'object' && !p.id && p.jid) return { ...p, id: p.jid };
            return p;
          }).filter(p => p && p.id);
        }
        groupCache.set(jid, meta);
        return meta;
      } catch { return undefined; }
    },
  });

  // Simpan ke global segera
  sockGlobal = sock;

  // ── Events ────────────────────────────────────────────────────
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n[WA] Scan QR Code ini:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const reason = DisconnectReason[code] || code;
      console.warn(`[WA] Disconnected: ${reason}`);

      // Bersihkan interval agar tidak numpuk saat reconnect
      if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }
      sockGlobal = null;

      if (code === DisconnectReason.loggedOut) {
        console.error("[WA] Session logout. Hapus auth_info dan restart.");
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        process.exit(1);
      }
      console.log("[WA] Reconnecting dalam 10 detik...");
      setTimeout(startSock, 10000);
    }

    if (connection === "open") {
      console.log("[WA] ✅ Bot READY!", sock.user);
      sockGlobal = sock;

      // Tunggu 3 detik sebelum aktif agar session decrypt siap
      await new Promise(r => setTimeout(r, 3000));
      console.log("[WA] Session warm-up selesai, siap terima pesan.");

      // Debug: tampilkan grup yang diikuti bot
      try {
        const groups = await sock.groupFetchAllParticipating();
        console.log("===== GRUP YANG DIIKUTI BOT =====");
        Object.entries(groups).forEach(([id, g]) => console.log(`  ${id} => ${g.subject}`));
        if (!groups[GRUP_NOTIF])
          console.warn(`⚠️  Bot TIDAK ADA di grup ${GRUP_NOTIF}! Notif tidak akan terkirim.`);
        console.log("=================================");
      } catch (e) { console.warn("[WA] Gagal fetch grup:", e.message); }

      // Start polling — satu interval, tidak numpuk
      if (!pollingTimer) {
        pollingTimer = setInterval(prosesAntrianKirim, 5000);
        console.log("[POLLING] Interval dimulai.");
      }

      setInterval(syncNomorDariLid, 30000); // cek setiap 30 detik
      syncNomorDariLid(); // langsung jalan saat bot ready
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // Retry pesan yang gagal decrypt (untuk grup/anggota baru)
  sock.ev.on("messages.update", async (updates) => {
    for (const update of updates) {
      if (update.update?.messageStubType === 2) {
        console.log("[RETRY] Pesan gagal decrypt, coba retry:", update.key);
        try {
          await sock.sendRetryRequest(update);
        } catch (e) {
          console.warn("[RETRY] Gagal:", e.message);
        }
      }
    }
  });

  // ── Pesan masuk ───────────────────────────────────────────────
  sock.ev.on("messages.upsert", async ({ messages: msgs, type }) => {
    if (type !== "notify") return;

    for (const msg of msgs) {
      if (msg.key.fromMe || !msg.message) continue;

      const fromJid = msg.key.remoteJid;
      if (!fromJid) continue;

      const msgType = Object.keys(msg.message)[0];

      // Log SEMUA pesan masuk sebelum filter apapun
      const bodyRaw = (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        msg.message?.documentMessage?.caption || ""
      ).trim();
      console.log(`[RAW MSG] from=${fromJid} participant=${msg.key.participant || ''} type=${msgType} body="${bodyRaw}"`);



      // GANTI JADI INI:
      const SKIP_TYPES = [
        "protocolMessage",
        "reactionMessage",
        "pollCreationMessage",
        "pollUpdateMessage",
      ];

      // Untuk senderKeyDistributionMessage, skip hanya jika body kosong
      if (msgType === "senderKeyDistributionMessage" && !bodyRaw) {
        console.log(`[SKIP] senderKeyDistributionMessage tanpa body`);
        continue;
      }
      if (SKIP_TYPES.includes(msgType)) continue;

      // const senderJid = isGroup(fromJid) ? (msg.key.participant || fromJid) : fromJid;
      const rawParticipant = msg.key.participant || msg.key.participantAlt || '';
      const participantStr = typeof rawParticipant === 'string'
        ? rawParticipant
        : (rawParticipant?.id || rawParticipant?.jid || '');
      const senderJid = isGroup(fromJid) ? (participantStr || fromJid) : fromJid;
      const bodyText = (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        msg.message?.documentMessage?.caption || ""
      ).trim();

      console.log(`[MSG] From:${senderJid} | Type:${msgType} | Body:"${bodyText}"`);
      const lc = bodyText.toLowerCase();

      // #proses<id>
      const matchProses = lc.match(/^#proses(\d+)/);
      if (matchProses) { await handleProses(msg, parseInt(matchProses[1]), senderJid); continue; }

      // #done<id> [solusi]
      const matchDone = lc.match(/^#done(\d+)/);
      if (matchDone) {
        const solusi = bodyText.replace(/#done\d+/i, "").trim() || null;
        await handleDone(msg, parseInt(matchDone[1]), solusi, senderJid);
        continue;
      }

      // ← TARUH DI SINI
const matchDaftar = lc.match(/^#daftar\s+([\d\s\-\+]+)/);
if (matchDaftar) {
  const nomorInput = normalizeNomor(matchDaftar[1].replace(/[\s\-]/g, ''));
  if (nomorInput.length < 10) {
    await kirimTeks(fromJid, `❌ Nomor tidak valid. Contoh: *#daftar 08123456789*`);
    continue;
  }

  const lidSender = isGroup(fromJid)
    ? (msg.key.participant || '')
    : fromJid;

  await pool.query(
    `UPDATE pengguna SET nomor_hp=$1 WHERE whatsapp_lid=$2`,
    [nomorInput, lidSender]
  ).catch(() => {});

  await pool.query(
    `INSERT INTO pengguna (nama_user, nomor_hp, whatsapp_lid)
     VALUES ($1, $2, $3)
     ON CONFLICT (whatsapp_lid) DO UPDATE SET nomor_hp = EXCLUDED.nomor_hp`,
    [msg.pushName || 'Unknown', nomorInput, lidSender]
  ).catch(() => {});

  await kirimTeks(fromJid, `✅ Nomor *${nomorInput}* berhasil didaftarkan. Terima kasih, *${msg.pushName || ''}*!`);
  console.log(`[DAFTAR] ✅ ${lidSender} → ${nomorInput}`);
  continue;
}

      const hasLapor = lc.includes("#lapor");
      const isMedia = ["imageMessage", "videoMessage", "documentMessage", "audioMessage"].includes(msgType);

      // Media tanpa #lapor — coba lampirkan ke buffer aktif
      if (!hasLapor && isMedia) {
        const tsBucket = Math.floor((msg.messageTimestamp || Date.now() / 1000) / 10);
        const keys = [
          `${senderJid}_media_${tsBucket}`,
          `${senderJid}_media_${tsBucket - 1}`,
          `${senderJid}_media_${tsBucket + 1}`,
        ];
        let activeKey = keys.find(k => albumBuffer.has(k) && !albumBuffer.get(k).processed);
        if (!activeKey) {
          for (const [k, v] of albumBuffer.entries()) {
            if (k.startsWith(senderJid + "_") && !v.processed) { activeKey = k; break; }
          }
        }
        if (activeKey) {
          const buf = albumBuffer.get(activeKey);
          buf.messages.push(msg);
          const file = await simpanMedia(msg, msg.key.id + "_" + Date.now()).catch(() => null);
          if (file) { buf.files.push(file); console.log(`[FILE] Tambahan → total:${buf.files.length}`); }
          if (buf.timer) clearTimeout(buf.timer);
          buf.timer = setTimeout(() => prosesLaporan(activeKey), 5000);
          albumBuffer.set(activeKey, buf);
          continue;
        }
        console.log("[MSG] Bukan #lapor & tidak ada buffer aktif, diabaikan.");
        continue;
      }

      if (!hasLapor) { console.log("[MSG] Bukan #lapor, diabaikan."); continue; }
      await handleLaporBuffer(msg, bodyText, senderJid, fromJid);
    }
  });

}

// ================================================================
// API: Update status dari dashboard
// ================================================================
app.post("/update-status", async (req, res) => {
  const { id, status, operator, solusi } = req.body;
  const namaOperator = operator || "Dashboard";
  try {
    const { rows } = await pool.query(
      `SELECT pengirim, nomor_pengirim, chat_id FROM pesan_masuk WHERE id=$1`, [id]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: "Laporan tidak ditemukan" });

    const lap = rows[0];
    const tujuan = await getTujuan(id);
    if (!tujuan) return res.status(400).json({ success: false, error: "Nomor tujuan tidak ditemukan" });

    if (status === 1) {
      await pool.query(`UPDATE pesan_masuk SET status_selesai=1, tgl_proses=LOCALTIMESTAMP(0) WHERE id=$1`, [id]);
      const pesan = `Halo *${lap.pengirim}*, laporan Anda *sedang kami proses*. Kami akan segera menindaklanjuti. 🔧`;

      // Kirim langsung ke user
      const berhasil = await kirimLangsungKeUser(tujuan, pesan);
      if (!berhasil) await antrikanKirim({ nomor_pengirim: tujuan, nama_pengirim: namaOperator, isi_pesan: pesan, id_pesan_masuk: id });

      await kirimTeks(GRUP_NOTIF,
        `🔄 *UPDATE* — Laporan *#${id}*\n👤 ${lap.pengirim}\n→ Status: *DIPROSES* oleh *${namaOperator}* (Dashboard)`
      ).catch(e => console.warn("[GRUP]", e.message));

    } else if (status === 2) {
      await pool.query(`UPDATE pesan_masuk SET status_selesai=2, tgl_selesai=LOCALTIMESTAMP(0) WHERE id=$1`, [id]);
      const pesan = `Halo *${lap.pengirim}*, laporan Anda telah *diselesaikan*. Terima kasih sudah melapor. 🙏` +
        (solusi ? `\n\n📝 *Solusi:* ${solusi}` : "");

      // Kirim langsung ke user
      const berhasil = await kirimLangsungKeUser(tujuan, pesan);
      if (!berhasil) await antrikanKirim({ nomor_pengirim: tujuan, nama_pengirim: namaOperator, isi_pesan: pesan, solusi: solusi || null, id_pesan_masuk: id });

      await kirimTeks(GRUP_NOTIF,
        `✅ *UPDATE* — Laporan *#${id}*\n👤 ${lap.pengirim}\n→ Status: *SELESAI* oleh *${namaOperator}* (Dashboard)` +
        (solusi ? `\n📝 Solusi: _${solusi}_` : "")
      ).catch(e => console.warn("[GRUP]", e.message));
    }

    res.json({ success: true });
  } catch (err) {
    console.error("[API] update-status:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ================================================================
// API: Kirim PDF ke WA
// ================================================================
app.post("/send-pdf", upload.single("pdf"), async (req, res) => {
  const { nomor, caption } = req.body;
  if (!nomor || !req.file) return res.status(400).json({ success: false, error: "nomor dan pdf wajib ada" });
  try {
    const raw = String(nomor).trim();
    const jid = raw.includes("@") ? raw.replace("@c.us", "@s.whatsapp.net") : toJid(raw);
    const name = `report_${Date.now()}.pdf`;
    const fp = path.join(UPLOAD_DIR, name);
    fs.writeFileSync(fp, req.file.buffer);
    await sockGlobal.sendMessage(jid, { document: req.file.buffer, mimetype: "application/pdf", fileName: name, caption: caption || "Laporan Helpdesk IT" });
    setTimeout(() => { try { fs.unlinkSync(fp); } catch { } }, 60000);
    console.log(`[SEND-PDF] ✅ → ${jid}`);
    res.json({ success: true });
  } catch (err) {
    console.error("[SEND-PDF]", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ================================================================
// API: Tambah laporan manual dari dashboard
// ================================================================
app.post("/tambah-laporan", upload.array("lampiran", 10), async (req, res) => {
  const { nama, nomor, unit, isi_pesan, kd_divisi, operator } = req.body;
  if (!isi_pesan) return res.status(400).json({ success: false, error: "isi_pesan wajib diisi" });
  try {
    const colWaktu = dbCache.colWaktu || "timestamp";
    const nomorFinal = nomor ? normalizeNomor(nomor) : "0";
    const pesanBersih = String(isi_pesan).replace(/#lapor/gi, "").trim();
    const whatsappId = `manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const kdDivisiVal = kd_divisi ? parseInt(kd_divisi) : await deteksiDivisi(pesanBersih);

    if (nomorFinal !== "0") await upsertPengguna(nomorFinal, nama || "Admin Input", null);

    const savedFiles = [];
    for (const f of (req.files || [])) {
      const ext = path.extname(f.originalname) || "";
      const name = `manual_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`;
      fs.writeFileSync(path.join(UPLOAD_DIR, name), f.buffer);
      savedFiles.push(`upload/${name}`);
    }

    const dbRes = await pool.query(
      `INSERT INTO pesan_masuk (nomor_pengirim,pengirim,isi_pesan,whatsapp_id,${colWaktu},attachments,kd_divisi,chat_id)
       VALUES ($1,$2,$3,$4,LOCALTIMESTAMP(0),$5,$6,$7) RETURNING id`,
      [nomorFinal, nama || "Admin Input", pesanBersih, whatsappId, savedFiles, kdDivisiVal, nomorFinal + "@s.whatsapp.net"]
    );
    const idBaru = dbRes.rows[0].id;
    const namaDivisi = await getNamaDivisi(kdDivisiVal);

    const notif =
      `📋 *LAPORAN MANUAL* — ID *#${idBaru}*\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `👤 *Nama    :* ${nama || "Admin Input"}\n` +
      (unit ? `🏥 *Unit    :* ${unit}\n` : "") +
      `📱 *Nomor   :* ${nomorFinal}\n` +
      `🕐 *Pukul   :* ${formatWIB()}\n` +
      `🏷️ *Divisi  :* ${namaDivisi}\n` +
      `📝 *Isi     :*\n${pesanBersih}\n` +
      (savedFiles.length ? `📎 *Lampiran:* ${savedFiles.length} file\n` : "") +
      `🖊️ *Input oleh:* ${operator || "Admin"}\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `• *#proses${idBaru}* → tandai diproses\n` +
      `• *#done${idBaru}* [solusi] → tandai selesai`;

    await kirimTeks(GRUP_NOTIF, notif).catch(e => console.warn("[GRUP] manual:", e.message));
    for (let i = 0; i < savedFiles.length; i++) {
      await kirimFile(GRUP_NOTIF, path.join(__dirname, savedFiles[i]), `📎 ${i + 1}/${savedFiles.length} — #${idBaru}`)
        .catch(e => console.warn(`[MANUAL] Gagal lampiran ${i + 1}:`, e.message));
    }

    res.json({ success: true, id: idBaru, lampiran: savedFiles.length });
  } catch (err) {
    console.error("[API] tambah-laporan:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ================================================================
// API: Lain-lain
// ================================================================
app.post("/send-reply", async (req, res) => {
  const { nomor, pesan } = req.body;
  try {
    await antrikanKirim({ nomor_pengirim: nomor, isi_pesan: pesan });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post("/update-divisi", async (req, res) => {
  const { id, kd_divisi } = req.body;
  if (!id) return res.status(400).json({ success: false, error: "id wajib" });
  try {
    await pool.query(`UPDATE pesan_masuk SET kd_divisi=$1 WHERE id=$2`, [kd_divisi || null, id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get("/list-groups", async (req, res) => {
  if (!sockGlobal) return res.status(503).json({ error: "WA belum ready" });
  try {
    const g = await sockGlobal.groupFetchAllParticipating();
    res.json(Object.entries(g).map(([id, m]) => ({ id, name: m.subject })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/debug-antrian", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id_kirim,nomor_pengirim,isi_pesan,status_kirim,tg_kirim,id_pesan_masuk
       FROM kirim_wa ORDER BY tg_kirim DESC LIMIT 20`
    );
    res.json({ total: rows.length, rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/debug-grup-participants", async (req, res) => {
  if (!sockGlobal) return res.status(503).json({ error: "WA belum ready" });
  try {
    const meta = await sockGlobal.groupMetadata(GRUP_NOTIF);
    // Tampilkan 5 participant pertama untuk lihat strukturnya
    const sample = (meta.participants || []).slice(0, 5).map(p => ({
      raw: p,
      id: p.id || p.jid || null,
      lid: p.lid || p.lidJid || null,
    }));
    res.json({ total: meta.participants?.length, sample });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/retry-gagal", async (req, res) => {
  try {
    const r = await pool.query(`UPDATE kirim_wa SET status_kirim=0,retry_count=0 WHERE status_kirim=2 RETURNING id_kirim`);
    res.json({ success: true, direset: r.rowCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/ping-wa", (req, res) => {
  res.json({ connected: sockGlobal?.ws?.readyState === 1, user: sockGlobal?.user || null });
});

app.get("/test-group", async (req, res) => {
  if (!sockGlobal) return res.status(503).json({ error: "WA belum ready" });
  try {
    await sockGlobal.sendMessage(GRUP_NOTIF, { text: "TEST GROUP dari API" });
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post("/logout", async (req, res) => {
  try {
    if (sockGlobal) await sockGlobal.logout().catch(() => { });
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    res.json({ success: true, message: "Session dihapus. Restart untuk scan QR baru." });
    setTimeout(() => process.exit(0), 1000);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Soft delete laporan
app.post("/hapus-laporan", async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ success: false, error: "id wajib" });
  try {
    await pool.query(`UPDATE pesan_masuk SET status_hapus=1 WHERE id=$1`, [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ================================================================
// Static files & start
// ================================================================
app.get("/sync-nomor-dari-grup", async (req, res) => {
  if (!sockGlobal) return res.status(503).json({ error: "WA belum ready" });
  try {
    const meta = await sockGlobal.groupMetadata(GRUP_NOTIF);
    const participants = meta.participants || [];

    let updated = 0;
    const hasil = [];

    for (const p of participants) {
      // Field dari object Baileys participant:
      const lid   = p.id || '';          // LID dari Baileys
      const phone = p.phoneNumber || ''; // Nomor HP dari Baileys

      if (!lid.endsWith('@lid') || !phone) continue;

      const nomor = normalizeNomor(phone);
      if (!nomor || nomor.length < 10) continue;

      // Update ke kolom DB yang benar (nomor_hp, whatsapp_lid)
      const r = await pool.query(
        `UPDATE pengguna
         SET nomor_hp = $1
         WHERE whatsapp_lid = $2
           AND (nomor_hp IS NULL OR nomor_hp = '' OR LENGTH(nomor_hp) < 10)
         RETURNING kd_user, nama_user, nomor_hp, whatsapp_lid`,
        [nomor, lid]
      );
      if (r.rowCount > 0) {
        updated++;
        hasil.push(r.rows[0]);
        console.log(`[SYNC] ✅ ${lid} → ${nomor} (${r.rows[0].nama_user})`);
      }
    }

    res.json({ success: true, total_participant: participants.length, updated, hasil });
  } catch (e) {
    console.error("[SYNC]", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/debug-sync-detail", async (req, res) => {
  if (!sockGlobal) return res.status(503).json({ error: "WA belum ready" });
  try {
    const meta = await sockGlobal.groupMetadata(GRUP_NOTIF);
    const participants = meta.participants || [];

    // Ambil semua data pengguna
    const dbRows = await pool.query(`SELECT nama_user, nomor_hp, whatsapp_lid FROM pengguna`);

    // Bandingkan LID dari grup vs LID di DB
    const grupLids = participants
      .filter(p => (p.id || '').endsWith('@lid') && p.phoneNumber)
      .map(p => ({ lid: p.id, phone: p.phoneNumber, nomor: normalizeNomor(p.phoneNumber) }));

    const dbLids = dbRows.rows.map(r => ({
      nama: r.nama_user,
      nomor_hp: r.nomor_hp,
      whatsapp_lid: r.whatsapp_lid,
    }));

    res.json({ dari_grup: grupLids, dari_db: dbLids });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/debug-kolom-pengguna", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT column_name, data_type 
       FROM information_schema.columns 
       WHERE table_name = 'pengguna' 
       ORDER BY ordinal_position`
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use("/upload", express.static(UPLOAD_DIR));
app.listen(8000, "0.0.0.0", () => console.log("[API] Server port 8000"));

startSock().catch(err => { console.error("[FATAL]", err.message); process.exit(1); });