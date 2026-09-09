/**
 * ================================================================
 * HELPDESK IT — WhatsApp Bot
 * @whiskeysockets/baileys | Session: ./auth_info | Node.js v20+
 * ================================================================
 * INSTALASI:
 *   npm install @whiskeysockets/baileys @hapi/boom pg express cors multer qrcode-terminal pino node-cache
 *
 * JALANKAN:
 *   node bailey.js
 *   pm2 start bailey.js --name bailey
 *
 * ================================================================
 * CATATAN MIGRASI ESM (Agustus 2026):
 * Baileys versi terbaru sudah full ESM-only, jadi file ini dikonversi
 * dari require()/module.exports ke import/export. Syarat supaya file
 * ini bisa jalan:
 *   1. package.json HARUS punya "type": "module"
 *   2. __dirname/__filename tidak tersedia otomatis di ESM, jadi
 *      di-derive manual lewat import.meta.url (lihat di bawah).
 * ================================================================
 * PERUBAHAN "MANUSIAWI" DI FILE INI:
 * 1. Setiap pengiriman pesan melalui ANTRIAN GLOBAL (queue) — tidak ada
 *    dua pesan yang terkirim bersamaan, semua dikirim satu per satu.
 * 2. Jeda ACAK 2-6 detik antar setiap pesan yang dikirim (meniru waktu
 *    orang mengetik/klik kirim), bukan langsung tembak beruntun.
 * 3. Status "mengetik..." (composing) disimulasikan sebelum kirim teks,
 *    durasinya proporsional dengan panjang pesan.
 * 4. Rate limit per menit — maksimal N pesan keluar per menit (default 20),
 *    kalau terlampaui, antrian otomatis menunggu sampai slot tersedia.
 * 5. Auto-reply ke pengirim diberi jeda kecil (simulasi "membaca dulu")
 *    sebelum membalas, bukan instan.
 * Semua helper kirim pesan asli (kirimTeks, kirimFile, kirimLangsungKeUser,
 * sock.sendMessage langsung) dialihkan melalui satu titik: enqueueKirim().
 * ================================================================
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";

import { Boom } from "@hapi/boom";
import pino from "pino";
import pg from "pg";
import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import multer from "multer";
import qrcode from "qrcode-terminal";
import NodeCache from "node-cache";
import { fileURLToPath } from "url";

const { Pool } = pg;

// __dirname / __filename tidak ada bawaan di ESM — derive manual
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ================================================================
// Express
// ================================================================
const app = express();
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use((req, res, next) => {
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
// app.use(express.json());
app.use(express.json({ limit: "20mb" }));
const upload = multer({ storage: multer.memoryStorage() });

// ================================================================
// Database
// ================================================================
const pool = new Pool({
  user: "postgres",
  host: "10.100.1.220",
  database: "db_aplikasi",
  password: "tanyadokterucu",
  port: 5432,
});
pool.on("error", (err) => console.error("[DB] Error:", err.message));
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

let sockGlobal = null; // selalu menunjuk socket terbaru
let pollingTimer = null; // satu interval saja, tidak numpuk
const albumBuffer = new Map();
const dbCache = {}; // cache kolom DB agar tidak query berulang
const pendingReadKeys = new Map();

const LAPOR_ORPHAN_GRACE_MS = 10000;

// ================================================================
// ===================  ANTRIAN PENGIRIMAN "MANUSIAWI"  ==========
// ================================================================
// Semua pesan keluar (teks/gambar/dokumen/video) lewat antrian ini,
// satu per satu, dengan jeda acak + simulasi mengetik + rate limit.

const KIRIM_DELAY_MIN_MS = 2000; // jeda minimum antar pesan (2 detik)
const KIRIM_DELAY_MAX_MS = 6000; // jeda maksimum antar pesan (6 detik)
const MAX_PESAN_PER_MENIT = 5; // batas wajar pesan keluar per menit
const TYPING_MS_PER_KARAKTER = 35; // estimasi waktu "mengetik" per karakter
const TYPING_MS_MAX = 4000; // typing tidak boleh lebih dari ini

const antrianKirimQueue = [];
let antrianSedangJalan = false;
let jejakWaktuKirim = []; // timestamp pesan-pesan terakhir untuk rate limit

function jedaAcak(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Tunggu sampai ada "slot" sesuai rate limit per menit
async function tungguRateLimit() {
  while (true) {
    const sekarang = Date.now();
    jejakWaktuKirim = jejakWaktuKirim.filter((t) => sekarang - t < 60000);
    if (jejakWaktuKirim.length < MAX_PESAN_PER_MENIT) return;
    const tunggu = 60000 - (sekarang - jejakWaktuKirim[0]) + 500;
    console.log(
      `[THROTTLE] ⏳ Rate limit tercapai (${
        jejakWaktuKirim.length
      }/${MAX_PESAN_PER_MENIT} per menit), tunggu ${Math.ceil(tunggu / 1000)}s`
    );
    await sleep(tunggu);
  }
}

// Tandai pesan sebagai "sudah dibaca" (centang biru) — dipanggil SEBELUM
// simulasi mengetik, supaya urutannya terasa manusiawi: baca dulu → ngetik → kirim
async function tandaiDibaca(messageKeys) {
  if (!sockGlobal || !messageKeys || !messageKeys.length) return;
  try {
    await sockGlobal.readMessages(messageKeys);
    console.log(`[SEEN] ✅ Ditandai dibaca: ${messageKeys.length} pesan`);
  } catch (e) {
    // gagal tandai dibaca bukan masalah fatal, lanjut saja
    console.warn(`[SEEN] ⚠ Gagal tandai dibaca: ${e.message}`);
  }
}

// Catat key pesan masuk ke buffer — BELUM ditandai dibaca, menunggu trigger
function catatPendingRead(jid, key) {
  if (!pendingReadKeys.has(jid)) pendingReadKeys.set(jid, []);
  pendingReadKeys.get(jid).push(key);
}

// Tandai SEMUA pesan yang menumpuk (termasuk chat casual di atasnya) sebagai
// dibaca sekaligus — dipanggil saat ada trigger (#laporsimrs / #proses / #done / #up)
async function tandaiSemuaPendingDibaca(jid) {
  const keys = pendingReadKeys.get(jid);
  if (keys && keys.length) {
    await tandaiDibaca(keys);
    pendingReadKeys.delete(jid);
  }
}

// Simulasi status "mengetik..." sebelum kirim teks
async function simulasiMengetik(jid, teks) {
  if (!sockGlobal) return;
  try {
    const durasi = Math.min(
      TYPING_MS_MAX,
      Math.max(700, (teks || "").length * TYPING_MS_PER_KARAKTER)
    );
    await sockGlobal.sendPresenceUpdate("composing", jid);
    await sleep(durasi);
    await sockGlobal.sendPresenceUpdate("paused", jid);
  } catch (e) {
    // presence update gagal bukan masalah fatal, lanjut saja
  }
}

// Worker antrian — jalan terus, proses satu per satu
async function jalankanAntrianKirim() {
  if (antrianSedangJalan) return;
  antrianSedangJalan = true;

  while (antrianKirimQueue.length > 0) {
    const job = antrianKirimQueue.shift();
    try {
      await tungguRateLimit();

      if (job.tipe === "teks") {
        await tandaiDibaca(job.seenKeys);
        await simulasiMengetik(job.jid, job.teks);
        await sockGlobal.sendMessage(job.jid, { text: job.teks });
        console.log(`[QUEUE] ✅ Teks → ${job.jid}`);
      } else if (job.tipe === "gambar") {
        await tandaiDibaca(job.seenKeys);
        await simulasiMengetik(job.jid, job.caption || "");
        await sockGlobal.sendMessage(job.jid, {
          image: job.buf,
          caption: job.caption || "",
        });
        console.log(`[QUEUE] ✅ Gambar → ${job.jid}`);
      } else if (job.tipe === "video") {
        await tandaiDibaca(job.seenKeys);
        await simulasiMengetik(job.jid, job.caption || "");
        await sockGlobal.sendMessage(job.jid, {
          video: job.buf,
          caption: job.caption || "",
        });
        console.log(`[QUEUE] ✅ Video → ${job.jid}`);
      } else if (job.tipe === "dokumen") {
        await tandaiDibaca(job.seenKeys);
        await simulasiMengetik(job.jid, job.caption || "");
        await sockGlobal.sendMessage(job.jid, {
          document: job.buf,
          mimetype: "application/octet-stream",
          fileName: job.fileName,
          caption: job.caption || "",
        });
        console.log(`[QUEUE] ✅ Dokumen → ${job.jid}`);
      }

      jejakWaktuKirim.push(Date.now());
      if (job.resolve) job.resolve(true);
    } catch (e) {
      console.warn(`[QUEUE] ⚠ Gagal kirim ke ${job.jid}: ${e.message}`);
      if (job.resolve) job.resolve(false);
    }

    // Jeda acak sebelum proses pesan berikutnya — ini yang bikin "manusiawi"
    if (antrianKirimQueue.length > 0) {
      const jeda = jedaAcak(KIRIM_DELAY_MIN_MS, KIRIM_DELAY_MAX_MS);
      await sleep(jeda);
    }
  }

  antrianSedangJalan = false;
}

// Tambahkan job ke antrian, return Promise yang resolve setelah terkirim
function enqueueKirim(job) {
  return new Promise((resolve) => {
    antrianKirimQueue.push({ ...job, resolve });
    jalankanAntrianKirim();
  });
}

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

// ================================================================
// Helper: cek apakah pushName "valid" (bukan kosong/simbol doang)
// ================================================================
function isNamaValid(nama) {
  if (!nama) return false;
  const bersih = String(nama).trim();
  if (!bersih) return false;
  // harus mengandung minimal 1 huruf atau angka (Unicode-aware)
  return /[\p{L}\p{N}]/u.test(bersih);
}

function toJid(nomor) {
  return normalizeNomor(nomor) + "@s.whatsapp.net";
}
function isGroup(jid) {
  return typeof jid === "string" && jid.endsWith("@g.us");
}
function isLid(jid) {
  return typeof jid === "string" && jid.endsWith("@lid");
}

// ================================================================
// Helper: resolve nomor HP dari group metadata via LID
// p.id = LID, p.phoneNumber = nomor HP
// ================================================================
async function resolveNomorDariGrup(sock, grupJid, lidJid) {
  try {
    const meta = await sock.groupMetadata(grupJid);
    if (!Array.isArray(meta?.participants)) return null;

    for (const p of meta.participants) {
      const pId = p.id || p.jid || "";
      const pPhone = p.phoneNumber || "";

      if (pId === lidJid && pPhone) {
        const nomor = normalizeNomor(pPhone);
        if (nomor && nomor.length >= 10) {
          console.log(`[RESOLVE] ✅ ${lidJid} → ${pPhone} → ${nomor}`);
          return nomor;
        }
      }
    }
    console.warn(
      `[RESOLVE] ❌ LID ${lidJid} tidak ditemukan di grup ${grupJid}`
    );
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
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ================================================================
// Helper: kirim teks — sekarang lewat antrian "manusiawi"
// ================================================================
async function kirimTeks(jid, teks, seenKeys = null) {
  if (!sockGlobal) {
    console.warn("[KIRIM] sock belum ready");
    return false;
  }
  return enqueueKirim({ tipe: "teks", jid, teks, seenKeys });
}

// ================================================================
// Helper: kirim file — sekarang lewat antrian "manusiawi"
// ================================================================
async function kirimFile(jid, filePath, caption) {
  if (!sockGlobal) {
    console.warn("[KIRIM FILE] sock belum ready");
    return false;
  }
  const buf = fs.readFileSync(filePath);
  const ext = filePath.split(".").pop().toLowerCase();

  if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) {
    return enqueueKirim({ tipe: "gambar", jid, buf, caption });
  } else if (["mp4", "3gp", "mov"].includes(ext)) {
    return enqueueKirim({ tipe: "video", jid, buf, caption });
  } else {
    return enqueueKirim({
      tipe: "dokumen",
      jid,
      buf,
      caption,
      fileName: path.basename(filePath),
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
    `SELECT nomor_pengirim, chat_id FROM pesan_masuk WHERE id = $1`,
    [idPesan]
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
// Helper: KIRIM LANGSUNG ke user (tetap lewat antrian, tapi prioritas
// tinggi karena dipanggil saat #proses / #done — pengguna menunggu balasan)
// ================================================================
async function kirimLangsungKeUser(tujuan, teks, seenKeys = null) {
  if (!sockGlobal) {
    console.warn("[KIRIM LANGSUNG] sock belum ready, masuk antrian saja");
    return false;
  }
  try {
    const ok = await enqueueKirim({
      tipe: "teks",
      jid: tujuan,
      teks,
      seenKeys,
    });
    if (ok) console.log(`[KIRIM LANGSUNG] ✅ Terkirim ke ${tujuan}`);
    else console.warn(`[KIRIM LANGSUNG] ⚠ Gagal ke ${tujuan}`);
    return ok;
  } catch (e) {
    console.warn(`[KIRIM LANGSUNG] ⚠ Gagal ke ${tujuan}: ${e.message}`);
    return false;
  }
}

// ================================================================
// Helper: catat SEMUA pengiriman ke kirim_wa — baik BERHASIL (status=1)
// maupun GAGAL (status=0). Yang gagal tetap akan di-retry otomatis
// oleh polling (prosesAntrianKirim), karena polling ambil status_kirim=0.
// ================================================================
async function antrikanKirim({
  nomor_pengirim,
  kd_user, // ⬅️ ganti dari nama_pengirim, sekarang int4
  isi_pesan,
  solusi,
  id_pesan_masuk,
  status_kirim = 0, // 0 = gagal, 1 = berhasil
  retry_count = 0,
}) {
  if (dbCache.kirimWaHasSolusi === undefined) {
    const r = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name='kirim_wa' AND column_name='solusi' LIMIT 1`
    );
    dbCache.kirimWaHasSolusi = r.rows.length > 0;
  }
  try {
    if (dbCache.kirimWaHasSolusi) {
      await pool.query(
        `INSERT INTO kirim_wa (nomor_pengirim,kd_user,isi_pesan,solusi,tg_kirim,status_kirim,id_pesan_masuk,retry_count)
         VALUES ($1,$2,$3,$4,LOCALTIMESTAMP(0),$5,$6,$7)`,
        [
          nomor_pengirim,
          kd_user || null,
          isi_pesan,
          solusi || null,
          status_kirim,
          id_pesan_masuk || null,
          retry_count,
        ]
      );
    } else {
      await pool.query(
        `INSERT INTO kirim_wa (nomor_pengirim,kd_user,isi_pesan,tg_kirim,status_kirim,id_pesan_masuk,retry_count)
         VALUES ($1,$2,$3,LOCALTIMESTAMP(0),$4,$5,$6)`,
        [
          nomor_pengirim,
          kd_user || null,
          isi_pesan,
          status_kirim,
          id_pesan_masuk || null,
          retry_count,
        ]
      );
    }
    console.log(
      `[CATAT KIRIM_WA] ${
        status_kirim === 1 ? "✅ Sukses" : "❌ Gagal, masuk antrian retry"
      } → ${nomor_pengirim} (kd_user=${kd_user || "-"})`
    );
  } catch (e) {
    console.error("[CATAT KIRIM_WA] Gagal insert log:", e.message);
  }
}

// ================================================================
// Helper: upsert pengguna
// ================================================================
async function upsertPengguna(nomorHP, namaUser, lid) {
  try {
    let row = null;
    let foundBy = null; // "lid" atau "nomor"

    // // Cari dulu via LID
    // if (lid) {
    //   const r = await pool.query(
    //     `SELECT kd_unit, nomor_hp, whatsapp_lid FROM pengguna WHERE whatsapp_lid=$1 LIMIT 1`,
    //     [lid]
    //   );
    //   if (r.rows.length) {
    //     row = r.rows[0];
    //     foundBy = "lid";
    //   }
    // }

    // Jika tidak ketemu via LID, cari via nomor HP
    // if (!row && nomorHP) {
    //   const r = await pool.query(
    //     `SELECT kd_unit, nomor_hp, whatsapp_lid FROM pengguna WHERE nomor_hp=$1 LIMIT 1`,
    //     [nomorHP]
    //   );
    //   if (r.rows.length) {
    //     row = r.rows[0];
    //     foundBy = "nomor";
    //   }
    // }

    if (lid) {
  const r = await pool.query(
    `SELECT kd_unit, nomor_hp, whatsapp_lid, nama_user FROM pengguna WHERE whatsapp_lid=$1 LIMIT 1`,
    [lid]
  );
  if (r.rows.length) {
    row = r.rows[0];
    foundBy = "lid";
  }
}

if (!row && nomorHP) {
  const r = await pool.query(
    `SELECT kd_unit, nomor_hp, whatsapp_lid, nama_user FROM pengguna WHERE nomor_hp=$1 LIMIT 1`,
    [nomorHP]
  );
  if (r.rows.length) {
    row = r.rows[0];
    foundBy = "nomor";
  }
}

    // if (row) {
    //   const updates = [];
    //   const params = [];
    //   let idx = 1;

    //   if (nomorHP && (!row.nomor_hp || row.nomor_hp !== nomorHP)) {
    //     updates.push(`nomor_hp=$${idx++}`);
    //     params.push(nomorHP);
    //     console.log(
    //       `[USER] nomor_hp: "${row.nomor_hp || "(kosong)"}" → "${nomorHP}"`
    //     );
    //   }

    //   if (lid && (!row.whatsapp_lid || row.whatsapp_lid !== lid)) {
    //     updates.push(`whatsapp_lid=$${idx++}`);
    //     params.push(lid);
    //     console.log(
    //       `[USER] whatsapp_lid: "${row.whatsapp_lid || "(kosong)"}" → "${lid}"`
    //     );
    //   }

    //   updates.push(`nama_user=$${idx++}`);
    //   params.push(namaUser);

    //   if (updates.length > 0) {
    //     let whereClause;
    //     if (foundBy === "lid") {
    //       whereClause = `whatsapp_lid=$${idx}`;
    //       params.push(lid);
    //     } else {
    //       whereClause = `nomor_hp=$${idx}`;
    //       params.push(row.nomor_hp);
    //     }

    //     const q = `UPDATE pengguna SET ${updates.join(
    //       ", "
    //     )} WHERE ${whereClause} RETURNING nomor_hp, whatsapp_lid`;
    //     const res = await pool.query(q, params);
    //     console.log(`[USER] ✅ Update (foundBy=${foundBy}):`, res.rows[0]);
    //   }

    //   return { kdUnit: row.kd_unit };
    // }

    if (row) {
  const updates = [];
  const params = [];
  let idx = 1;

  if (nomorHP && (!row.nomor_hp || row.nomor_hp !== nomorHP)) {
    updates.push(`nomor_hp=$${idx++}`);
    params.push(nomorHP);
    console.log(
      `[USER] nomor_hp: "${row.nomor_hp || "(kosong)"}" → "${nomorHP}"`
    );
  }

  if (lid && (!row.whatsapp_lid || row.whatsapp_lid !== lid)) {
    updates.push(`whatsapp_lid=$${idx++}`);
    params.push(lid);
    console.log(
      `[USER] whatsapp_lid: "${row.whatsapp_lid || "(kosong)"}" → "${lid}"`
    );
  }

  // ⬇️ HANYA update nama_user kalau baris ini BELUM punya nama valid.
  // Kalau admin sudah mengedit nama secara manual di DB, itu tidak akan
  // pernah tertimpa lagi oleh pushName WhatsApp pada laporan berikutnya.
  if (!isNamaValid(row.nama_user)) {
    updates.push(`nama_user=$${idx++}`);
    params.push(namaUser);
    console.log(
      `[USER] nama_user: "${row.nama_user || "(kosong)"}" → "${namaUser}" (nama lama belum valid)`
    );
  }

  if (updates.length > 0) {
    let whereClause;
    if (foundBy === "lid") {
      whereClause = `whatsapp_lid=$${idx}`;
      params.push(lid);
    } else {
      whereClause = `nomor_hp=$${idx}`;
      params.push(row.nomor_hp);
    }

    const q = `UPDATE pengguna SET ${updates.join(
      ", "
    )} WHERE ${whereClause} RETURNING nomor_hp, whatsapp_lid`;
    const res = await pool.query(q, params);
    console.log(`[USER] ✅ Update (foundBy=${foundBy}):`, res.rows[0]);
  }

  return { kdUnit: row.kd_unit };
}
    if (nomorHP) {
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
  // Simpan ke tabel khusus supaya bisa dilacak & di-backfill,
  // tidak hilang diam-diam lagi seperti kasus Wahyuni.
  try {
    await pool.query(
      `INSERT INTO pengguna_gagal_insert (nama_user, nomor_hp, whatsapp_lid, error_message)
       VALUES ($1, $2, $3, $4)`,
      [namaUser, nomorHP || null, lid || null, e.message]
    );
    console.warn(`[USER] ⚠️ Dicatat ke pengguna_gagal_insert untuk di-backfill nanti`);
  } catch (e2) {
    console.error(`[USER] ❌ Bahkan gagal catat ke pengguna_gagal_insert:`, e2.message);
  }
  return { kdUnit: null };
}
}

// ================================================================
// Helper: ambil kd_user dari tabel pengguna berdasarkan nomor/LID.
// Kalau belum ada di tabel pengguna, buat baru lalu ambil kd_user
// yang baru ter-generate.
// ================================================================
async function ambilAtauBuatKdUser(nomorPengirim, namaPengirim) {
  if (!nomorPengirim || nomorPengirim === "unknown") return null;

  const isLid = nomorPengirim.endsWith("@lid");
  const kolom = isLid ? "whatsapp_lid" : "nomor_hp";

  try {
    // 1) Coba cari yang sudah ada di tabel pengguna
    const cek = await pool.query(
      `SELECT kd_user FROM pengguna WHERE ${kolom} = $1 LIMIT 1`,
      [nomorPengirim]
    );
    if (cek.rows.length && cek.rows[0].kd_user) {
      console.log(
        `[KD_USER] ✅ Ditemukan: ${nomorPengirim} → kd_user=${cek.rows[0].kd_user}`
      );
      return cek.rows[0].kd_user;
    }

    // 2) Belum ada → buat baru, lalu ambil kd_user yang baru ter-generate
    const namaFinal = isNamaValid(namaPengirim)
      ? namaPengirim.trim()
      : nomorPengirim;

    let ins;
    if (isLid) {
      ins = await pool.query(
        `INSERT INTO pengguna (nama_user, nomor_hp, whatsapp_lid, kd_unit)
         VALUES ($1, NULL, $2, NULL)
         ON CONFLICT (whatsapp_lid) DO UPDATE
           SET nama_user = EXCLUDED.nama_user
         RETURNING kd_user`,
        [namaFinal, nomorPengirim]
      );
    } else {
      ins = await pool.query(
        `INSERT INTO pengguna (nama_user, nomor_hp, whatsapp_lid, kd_unit)
         VALUES ($1, $2, NULL, NULL)
         ON CONFLICT (nomor_hp) DO UPDATE
           SET nama_user = EXCLUDED.nama_user
         RETURNING kd_user`,
        [namaFinal, nomorPengirim]
      );
    }

    const kdBaru = ins.rows[0]?.kd_user || null;
    console.log(
      `[KD_USER] 🆕 Baru dibuat: ${nomorPengirim} → kd_user=${kdBaru}`
    );
    return kdBaru;
  } catch (e) {
    console.warn(
      `[KD_USER] Gagal ambil/buat kd_user untuk ${nomorPengirim}: ${e.message}`
    );
    return null;
  }
}

// ================================================================
// Helper: FUZZY MATCHING (jarak edit Levenshtein) — supaya typo kecil
// pada nama unit/keyword tetap terdeteksi.
// Contoh: "anastesi" ↔ "anestesi", "komputir" ↔ "komputer".
// ================================================================
function levenshteinDistance(a, b) {
  a = a || "";
  b = b || "";
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prevRow = new Array(n + 1);
  let currRow = new Array(n + 1);
  for (let j = 0; j <= n; j++) prevRow[j] = j;

  for (let i = 1; i <= m; i++) {
    currRow[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[j] = Math.min(
        prevRow[j] + 1, // hapus 1 huruf
        currRow[j - 1] + 1, // tambah 1 huruf
        prevRow[j - 1] + cost // ganti 1 huruf
      );
    }
    const tmp = prevRow;
    prevRow = currRow;
    currRow = tmp;
  }
  return prevRow[n];
}

// Toleransi jarak edit berdasarkan panjang kata — kata pendek harus lebih
// persis, kata panjang boleh lebih banyak typo (maks ~20% dari panjangnya).
function toleransiEdit(len) {
  if (len <= 3) return 0; // kata sangat pendek: harus persis
  if (len <= 6) return 1; // mis. "poli", "unit": toleransi 1 huruf beda
  if (len <= 10) return 2; // mis. "anestesi", "komputer": toleransi 2 huruf
  return Math.floor(len * 0.2); // kata panjang: toleransi ~20%
}

// Cek apakah `keyword` (bisa multi-kata, mis. "poli anestesi") ada di
// dalam `teks`, dengan toleransi typo per kata. Exact substring match
// dicoba dulu (jalur cepat, 100% akurat untuk kasus normal), baru kalau
// tidak ketemu dicoba fuzzy per-kata secara berurutan.
function fuzzyIncludes(teks, keyword) {
  if (!teks || !keyword) return false;
  if (teks.includes(keyword)) return true; // exact match dulu

  const teksWords = teks.split(/\s+/).filter(Boolean);
  const keywordWords = keyword.split(/\s+/).filter(Boolean);
  const n = keywordWords.length;
  if (n === 0 || teksWords.length < n) return false;

  for (let i = 0; i <= teksWords.length - n; i++) {
    let cocokSemua = true;
    for (let j = 0; j < n; j++) {
      const kataTeks = teksWords[i + j];
      const kataKeyword = keywordWords[j];
      const dist = levenshteinDistance(kataTeks, kataKeyword);
      if (dist > toleransiEdit(kataKeyword.length)) {
        cocokSemua = false;
        break;
      }
    }
    if (cocokSemua) return true;
  }
  return false;
}


// ================================================================
// Handler: #cekopen
// Cek semua laporan yang masih berstatus OPEN (status_selesai=0,
// belum dihapus) lalu kirim daftarnya ke GRUP_NOTIF. Bisa dipicu
// dari mana saja (DM/grup manapun), hasilnya SELALU dikirim ke
// grup notif supaya semua tim melihat daftar yang sama.
// ================================================================
function buildDaftarOpenChunks(rows, unitMap) {
  const CHUNK_SIZE = 20; // pecah per 20 laporan biar pesan tidak kepanjangan
  const STATUS_LABEL = {
    0: "🟢 OPEN",
    1: "🟡 PROSES",
  };
  const chunks = [];
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const bagian = rows.slice(i, i + CHUNK_SIZE);
    const daftar = bagian
      .map((r, idx) => {
        const nomorUrut = i + idx + 1;
        const namaUnit = unitMap[r.kd_unit_pelapor] || "-";
        const waktu = r.waktu
          ? new Date(r.waktu).toLocaleString("id-ID", {
              timeZone: "Asia/Jakarta",
              day: "2-digit",
              month: "2-digit",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })
          : "-";
        const isiSingkat =
          (r.isi_pesan || "-").length > 60
            ? r.isi_pesan.slice(0, 60) + "…"
            : r.isi_pesan || "-";
        const statusLabel =
          STATUS_LABEL[r.status_selesai] ?? `Status ${r.status_selesai}`;
        return `${nomorUrut}. *#${r.id}* — ${statusLabel}\n    👤 ${r.pengirim || "-"} (${namaUnit})\n    🕐 ${waktu}\n    📝 ${isiSingkat}`;
      })
      .join("\n\n");
    chunks.push(daftar);
  }
  return chunks;
}

async function handleCekOpen(msg, senderJid, fromJid) {
  console.log(`[CEKOPEN] diminta oleh ${senderJid} dari ${fromJid}`);
  const replyTo = fromJid;
  await tandaiDibaca([msg.key]);
  try {
    const colWaktu = dbCache.colWaktu || "timestamp";
    const { rows } = await pool.query(
      `SELECT id, pengirim, isi_pesan, kd_unit_pelapor, status_selesai, ${colWaktu} AS waktu
       FROM pesan_masuk
       WHERE (status_selesai = 0 OR status_selesai = 1)
         AND (status_hapus IS NULL OR status_hapus = 0)
       ORDER BY id ASC`
    );

    if (!rows.length) {
      await kirimTeks(
        GRUP_NOTIF,
        `✅ Tidak ada laporan yang berstatus *OPEN* maupun *PROSES* saat ini.`
      );
      if (fromJid !== GRUP_NOTIF) {
        await kirimTeks(
          replyTo,
          `✅ Tidak ada laporan yang belum selesai. Info sudah dikirim ke grup notif.`
        );
      }
      console.log(`[CEKOPEN] ✅ Tidak ada laporan yang belum selesai`);
      return;
    }

    const unitRes = await pool
      .query(`SELECT kd_unit, nama_unit FROM unit`)
      .catch(() => ({ rows: [] }));
    const unitMap = {};
    for (const u of unitRes.rows) unitMap[u.kd_unit] = u.nama_unit;

    const chunks = buildDaftarOpenChunks(rows, unitMap);
    const totalBagian = chunks.length;
    const jmlOpen = rows.filter((r) => r.status_selesai === 0).length;
    const jmlProses = rows.filter((r) => r.status_selesai === 1).length;

    for (let i = 0; i < chunks.length; i++) {
      const judul =
        totalBagian > 1
          ? `📋 *DAFTAR LAPORAN BELUM SELESAI* (🟢${jmlOpen} OPEN 🟡${jmlProses} PROSES) — Bagian ${
              i + 1
            }/${totalBagian}\n━━━━━━━━━━━━━━━━━\n`
          : `📋 *DAFTAR LAPORAN BELUM SELESAI* (🟢${jmlOpen} OPEN 🟡${jmlProses} PROSES)\n━━━━━━━━━━━━━━━━━\n`;
      const penutup =
        i === chunks.length - 1
          ? `\n━━━━━━━━━━━━━━━━━\nBalas dengan *#proses<ID>* untuk mulai memproses. dan *#done<ID> untuk menyelesaikan*`
          : "";
      await kirimTeks(GRUP_NOTIF, judul + chunks[i] + penutup);
    }

    console.log(
      `[CEKOPEN] ✅ ${rows.length} laporan (🟢${jmlOpen} 🟡${jmlProses}) dikirim ke grup (${totalBagian} bagian)`
    );

    if (fromJid !== GRUP_NOTIF) {
      await kirimTeks(
        replyTo,
        `✅ Daftar laporan yang belum selsai (${rows.length}) sudah dikirim ke grup notif.`
      );
    }
  } catch (err) {
    console.error("[CEKOPEN] Error:", err.message);
    await kirimTeks(replyTo, `❌ Gagal cek laporan open: ${err.message}`);
  }
}

// ================================================================
// Handler: #opentoday
// Sama seperti #cekopen, tapi hanya laporan yang masuk HARI INI
// (berdasarkan kolom waktu, dibandingkan dengan tanggal server).
// ================================================================
async function handleOpenToday(msg, senderJid, fromJid) {
  console.log(`[OPENTODAY] diminta oleh ${senderJid} dari ${fromJid}`);
  const replyTo = fromJid;
  await tandaiDibaca([msg.key]);
  try {
    const colWaktu = dbCache.colWaktu || "timestamp";
    const { rows } = await pool.query(
      `SELECT id, pengirim, isi_pesan, kd_unit_pelapor, status_selesai, ${colWaktu} AS waktu
       FROM pesan_masuk
       WHERE (status_selesai = 0 OR status_selesai = 1)
         AND (status_hapus IS NULL OR status_hapus = 0)
         AND ${colWaktu}::date = CURRENT_DATE
       ORDER BY id ASC`
    );

    if (!rows.length) {
      await kirimTeks(
        GRUP_NOTIF,
        `✅ Tidak ada laporan yang belum selesai untuk hari ini.`
      );
      if (fromJid !== GRUP_NOTIF) {
        await kirimTeks(
          replyTo,
          `✅ Tidak ada laporan yang belum selesai hari ini. Info sudah dikirim ke grup notif.`
        );
      }
      console.log(`[OPENTODAY] ✅ Tidak ada laporan yang belum selesai hari ini`);
      return;
    }

    const unitRes = await pool
      .query(`SELECT kd_unit, nama_unit FROM unit`)
      .catch(() => ({ rows: [] }));
    const unitMap = {};
    for (const u of unitRes.rows) unitMap[u.kd_unit] = u.nama_unit;

    const chunks = buildDaftarOpenChunks(rows, unitMap);
    const totalBagian = chunks.length;
    const jmlOpen = rows.filter((r) => r.status_selesai === 0).length;
    const jmlProses = rows.filter((r) => r.status_selesai === 1).length;

    for (let i = 0; i < chunks.length; i++) {
      const judul =
        totalBagian > 1
          ? `📋 *DAFTAR LAPORAN BELUM SELESAI HARI INI* (🟢${jmlOpen} OPEN 🟡${jmlProses} PROSES) — Bagian ${
              i + 1
            }/${totalBagian}\n━━━━━━━━━━━━━━━━━\n`
          : `📋 *DAFTAR LAPORAN BELUM SELESAI HARI INI* (🟢${jmlOpen} OPEN 🟡${jmlProses} PROSES)\n━━━━━━━━━━━━━━━━━\n`;
      const penutup =
        i === chunks.length - 1
          ? `\n━━━━━━━━━━━━━━━━━\nBalas dengan *#proses<ID>* untuk mulai memproses. dan *#done<ID> untuk menyelesaikan`
          : "";
      await kirimTeks(GRUP_NOTIF, judul + chunks[i] + penutup);
    }

    console.log(
      `[OPENTODAY] ✅ ${rows.length} laporan hari ini (🟢${jmlOpen} 🟡${jmlProses}) dikirim ke grup (${totalBagian} bagian)`
    );

    if (fromJid !== GRUP_NOTIF) {
      await kirimTeks(
        replyTo,
        `✅ Daftar laporan yang belum selesai hari ini (${rows.length}) sudah dikirim ke grup notif.`
      );
    }
  } catch (err) {
    console.error("[OPENTODAY] Error:", err.message);
    await kirimTeks(
      replyTo,
      `❌ Gagal cek laporan open hari ini: ${err.message}`
    );
  }
}

// ================================================================
// Handler: #sum
// Ringkasan laporan HARI INI:
// - Total laporan masuk hari ini + breakdown status saat ini
// - Total yang DIPROSES hari ini (berdasarkan tgl_proses, bukan
//   tanggal masuknya — jadi laporan kemarin yang baru diproses hari
//   ini tetap terhitung)
// - Total yang DISELESAIKAN hari ini (berdasarkan tgl_selesai)
// - Ranking petugas: paling banyak memproses & paling banyak
//   menyelesaikan (hari ini)
// ================================================================
async function handleSum(msg, senderJid, fromJid) {
  console.log(`[SUM] diminta oleh ${senderJid} dari ${fromJid}`);
  const replyTo = fromJid;
  await tandaiDibaca([msg.key]);
  try {
    const colWaktu = dbCache.colWaktu || "timestamp";

    // 1) Laporan yang MASUK hari ini + breakdown status saat ini
    const masukRes = await pool.query(
      `SELECT status_selesai, COUNT(*) AS jumlah
       FROM pesan_masuk
       WHERE (status_hapus IS NULL OR status_hapus = 0)
         AND ${colWaktu}::date = CURRENT_DATE
       GROUP BY status_selesai`
    );
    const totalMasuk = masukRes.rows.reduce(
      (a, r) => a + parseInt(r.jumlah),
      0
    );
    const byStatus = { 0: 0, 1: 0, 2: 0, 3: 0 };
    for (const r of masukRes.rows) {
      byStatus[r.status_selesai] = parseInt(r.jumlah);
    }

    // 2) Total DIPROSES hari ini (berdasarkan tgl_proses, tanpa syarat
    //    kapan laporan itu masuk)
    const prosesRes = await pool.query(
      `SELECT COUNT(*) AS jumlah
       FROM pesan_masuk
       WHERE (status_hapus IS NULL OR status_hapus = 0)
         AND tgl_proses::date = CURRENT_DATE`
    );
    const totalDiprosesHariIni = parseInt(prosesRes.rows[0]?.jumlah || 0);

    // 3) Total DISELESAIKAN hari ini (berdasarkan tgl_selesai)
    const selesaiRes = await pool.query(
      `SELECT COUNT(*) AS jumlah
       FROM pesan_masuk
       WHERE (status_hapus IS NULL OR status_hapus = 0)
         AND tgl_selesai::date = CURRENT_DATE`
    );
    const totalSelesaiHariIni = parseInt(selesaiRes.rows[0]?.jumlah || 0);

    // ================================================================
    // 3.5) RESPONSE TIME — dihitung dari selisih waktu laporan MASUK
    // sampai MULAI DIPROSES (tgl_proses - waktu masuk), untuk laporan
    // yang diproses HARI INI. Response time dalam MENIT.
    // ================================================================
    const responTimeRes = await pool.query(
      `SELECT
         EXTRACT(EPOCH FROM (tgl_proses - ${colWaktu})) / 60 AS menit_respon
       FROM pesan_masuk
       WHERE (status_hapus IS NULL OR status_hapus = 0)
         AND tgl_proses IS NOT NULL
         AND tgl_proses::date = CURRENT_DATE
         AND ${colWaktu} IS NOT NULL`
    );

    const daftarMenit = responTimeRes.rows
      .map((r) => parseFloat(r.menit_respon))
      .filter((m) => !isNaN(m) && m >= 0); // buang data anomali (negatif/null)

    const totalRespon = daftarMenit.length;
    const rataRataMenit =
      totalRespon > 0
        ? daftarMenit.reduce((a, b) => a + b, 0) / totalRespon
        : 0;
    const jmlCepat = daftarMenit.filter((m) => m < 10).length; // < 10 menit
    const jmlLambat = daftarMenit.filter((m) => m >= 10).length; // >= 10 menit
    const persenCepat =
      totalRespon > 0 ? ((jmlCepat / totalRespon) * 100).toFixed(1) : "0.0";
    const persenLambat =
      totalRespon > 0 ? ((jmlLambat / totalRespon) * 100).toFixed(1) : "0.0";

    // Helper format menit → "Xj Ym" atau "Y menit"
    const fmtMenit = (menit) => {
      if (menit < 60) return `${menit.toFixed(1)} menit`;
      const jam = Math.floor(menit / 60);
      const sisaMenit = Math.round(menit % 60);
      return `${jam} jam ${sisaMenit} menit`;
    };

    // 4) Ranking petugas paling banyak MEMPROSES hari ini
    const rankProsesRes = await pool.query(
      `SELECT pm.kd_user_proses AS kd_user, COALESCE(p.nama_user, 'Tidak diketahui') AS nama,
              COUNT(*) AS jumlah
       FROM pesan_masuk pm
       LEFT JOIN pengguna p ON p.kd_user = pm.kd_user_proses
       WHERE (pm.status_hapus IS NULL OR pm.status_hapus = 0)
         AND pm.tgl_proses::date = CURRENT_DATE
         AND pm.kd_user_proses IS NOT NULL
       GROUP BY pm.kd_user_proses, p.nama_user
       ORDER BY jumlah DESC
       LIMIT 5`
    );

    // 5) Ranking petugas paling banyak MENYELESAIKAN hari ini
    const rankDoneRes = await pool.query(
      `SELECT pm.kd_user_done AS kd_user, COALESCE(p.nama_user, 'Tidak diketahui') AS nama,
              COUNT(*) AS jumlah
       FROM pesan_masuk pm
       LEFT JOIN pengguna p ON p.kd_user = pm.kd_user_done
       WHERE (pm.status_hapus IS NULL OR pm.status_hapus = 0)
         AND pm.tgl_selesai::date = CURRENT_DATE
         AND pm.kd_user_done IS NOT NULL
       GROUP BY pm.kd_user_done, p.nama_user
       ORDER BY jumlah DESC
       LIMIT 5`
    );

    // ── Susun pesan ──────────────────────────────────────────────
    let pesan =
      `📊 *RINGKASAN LAPORAN HARI INI* (${formatWIB()})\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `📥 *Masuk hari ini* : ${totalMasuk}\n` +
      `   🟢 Open           : ${byStatus[0]}\n` +
      `   🟡 Proses         : ${byStatus[1]}\n` +
      `   ✅ Selesai        : ${byStatus[2]}\n` +
      `   🔴 Perlu TL       : ${byStatus[3]}\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `🔧 *Diproses hari ini*   : ${totalDiprosesHariIni}\n` +
      `🏁 *Diselesaikan hari ini*: ${totalSelesaiHariIni}\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `⏱️ *RESPONSE TIME* (masuk → mulai diproses)\n` +
      `   📈 Rata-rata     : ${totalRespon > 0 ? fmtMenit(rataRataMenit) : "-"}\n` +
      `   ⚡ < 10 menit    : ${jmlCepat} dari ${totalRespon} (${persenCepat}%)\n` +
      `   🐢 ≥ 10 menit    : ${jmlLambat} dari ${totalRespon} (${persenLambat}%)\n` +
      `━━━━━━━━━━━━━━━━━\n`;

    pesan += `🏆 *Top Petugas — Paling Banyak Memproses*\n`;
    if (!rankProsesRes.rows.length) {
      pesan += `   _(belum ada data hari ini)_\n`;
    } else {
      rankProsesRes.rows.forEach((r, i) => {
        pesan += `   ${i + 1}. ${r.nama} — ${r.jumlah} laporan\n`;
      });
    }

    pesan += `\n🏆 *Top Petugas — Paling Banyak Menyelesaikan*\n`;
    if (!rankDoneRes.rows.length) {
      pesan += `   _(belum ada data hari ini)_\n`;
    } else {
      rankDoneRes.rows.forEach((r, i) => {
        pesan += `   ${i + 1}. ${r.nama} — ${r.jumlah} laporan\n`;
      });
    }

    await kirimTeks(GRUP_NOTIF, pesan);
    console.log(`[SUM] ✅ Ringkasan hari ini dikirim ke grup`);

    if (fromJid !== GRUP_NOTIF) {
      await kirimTeks(replyTo, `✅ Ringkasan hari ini sudah dikirim ke grup notif.`);
    }
  } catch (err) {
    console.error("[SUM] Error:", err.message);
    await kirimTeks(replyTo, `❌ Gagal membuat ringkasan: ${err.message}`);
  }
}

// ================================================================
// Helper: nama bulan Indonesia (untuk label)
// ================================================================
const NAMA_BULAN_ID = [
  "", "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

// ================================================================
// Handler INTI: #sum untuk PERIODE tertentu (tahun/bulan/triwulan/semester)
// Menerima rentang tanggal [tglMulai, tglAkhirExclusive) dalam format
// 'YYYY-MM-DD' dan label periode untuk judul pesan. Semua turunan
// (sumy, sumbulan, sumt, sums) tinggal memanggil ini dengan rentang
// yang sesuai — logikanya sama persis dengan #sum harian, hanya
// filter tanggalnya yang berbeda.
// ================================================================
async function handleSumPeriode(
  msg,
  senderJid,
  fromJid,
  tglMulai,
  tglAkhirExclusive,
  labelPeriode
) {
  console.log(
    `[SUM PERIODE] "${labelPeriode}" (${tglMulai} s/d <${tglAkhirExclusive}) diminta oleh ${senderJid}`
  );
  const replyTo = fromJid;
  await tandaiDibaca([msg.key]);
  try {
    const colWaktu = dbCache.colWaktu || "timestamp";

    // 1) Laporan yang MASUK pada periode ini + breakdown status saat ini
    const masukRes = await pool.query(
      `SELECT status_selesai, COUNT(*) AS jumlah
       FROM pesan_masuk
       WHERE (status_hapus IS NULL OR status_hapus = 0)
         AND ${colWaktu} >= $1::timestamp
         AND ${colWaktu} < $2::timestamp
       GROUP BY status_selesai`,
      [tglMulai, tglAkhirExclusive]
    );
    const totalMasuk = masukRes.rows.reduce(
      (a, r) => a + parseInt(r.jumlah),
      0
    );
    const byStatus = { 0: 0, 1: 0, 2: 0, 3: 0 };
    for (const r of masukRes.rows) {
      byStatus[r.status_selesai] = parseInt(r.jumlah);
    }

    // 2) Total DIPROSES pada periode ini (berdasarkan tgl_proses)
    const prosesRes = await pool.query(
      `SELECT COUNT(*) AS jumlah
       FROM pesan_masuk
       WHERE (status_hapus IS NULL OR status_hapus = 0)
         AND tgl_proses >= $1::timestamp
         AND tgl_proses < $2::timestamp`,
      [tglMulai, tglAkhirExclusive]
    );
    const totalDiproses = parseInt(prosesRes.rows[0]?.jumlah || 0);

    // 3) Total DISELESAIKAN pada periode ini (berdasarkan tgl_selesai)
    const selesaiRes = await pool.query(
      `SELECT COUNT(*) AS jumlah
       FROM pesan_masuk
       WHERE (status_hapus IS NULL OR status_hapus = 0)
         AND tgl_selesai >= $1::timestamp
         AND tgl_selesai < $2::timestamp`,
      [tglMulai, tglAkhirExclusive]
    );
    const totalSelesai = parseInt(selesaiRes.rows[0]?.jumlah || 0);

    // ================================================================
    // 3.5) RESPONSE TIME — selisih waktu MASUK sampai MULAI DIPROSES
    // (tgl_proses - waktu masuk), untuk laporan yang DIPROSES pada
    // periode ini. Dalam MENIT.
    // ================================================================
    const responTimeRes = await pool.query(
      `SELECT
         EXTRACT(EPOCH FROM (tgl_proses - ${colWaktu})) / 60 AS menit_respon
       FROM pesan_masuk
       WHERE (status_hapus IS NULL OR status_hapus = 0)
         AND tgl_proses IS NOT NULL
         AND tgl_proses >= $1::timestamp
         AND tgl_proses < $2::timestamp
         AND ${colWaktu} IS NOT NULL`,
      [tglMulai, tglAkhirExclusive]
    );

    const daftarMenit = responTimeRes.rows
      .map((r) => parseFloat(r.menit_respon))
      .filter((m) => !isNaN(m) && m >= 0);

    const totalRespon = daftarMenit.length;
    const rataRataMenit =
      totalRespon > 0
        ? daftarMenit.reduce((a, b) => a + b, 0) / totalRespon
        : 0;
    const jmlCepat = daftarMenit.filter((m) => m < 10).length;
    const jmlLambat = daftarMenit.filter((m) => m >= 10).length;
    const persenCepat =
      totalRespon > 0 ? ((jmlCepat / totalRespon) * 100).toFixed(1) : "0.0";
    const persenLambat =
      totalRespon > 0 ? ((jmlLambat / totalRespon) * 100).toFixed(1) : "0.0";

    const fmtMenit = (menit) => {
      if (menit < 60) return `${menit.toFixed(1)} menit`;
      const jam = Math.floor(menit / 60);
      const sisaMenit = Math.round(menit % 60);
      return `${jam} jam ${sisaMenit} menit`;
    };

    // 4) Ranking petugas paling banyak MEMPROSES pada periode ini
    const rankProsesRes = await pool.query(
      `SELECT pm.kd_user_proses AS kd_user, COALESCE(p.nama_user, 'Tidak diketahui') AS nama,
              COUNT(*) AS jumlah
       FROM pesan_masuk pm
       LEFT JOIN pengguna p ON p.kd_user = pm.kd_user_proses
       WHERE (pm.status_hapus IS NULL OR pm.status_hapus = 0)
         AND pm.tgl_proses >= $1::timestamp
         AND pm.tgl_proses < $2::timestamp
         AND pm.kd_user_proses IS NOT NULL
       GROUP BY pm.kd_user_proses, p.nama_user
       ORDER BY jumlah DESC
       LIMIT 10`,
      [tglMulai, tglAkhirExclusive]
    );

    // 5) Ranking petugas paling banyak MENYELESAIKAN pada periode ini
    const rankDoneRes = await pool.query(
      `SELECT pm.kd_user_done AS kd_user, COALESCE(p.nama_user, 'Tidak diketahui') AS nama,
              COUNT(*) AS jumlah
       FROM pesan_masuk pm
       LEFT JOIN pengguna p ON p.kd_user = pm.kd_user_done
       WHERE (pm.status_hapus IS NULL OR pm.status_hapus = 0)
         AND pm.tgl_selesai >= $1::timestamp
         AND pm.tgl_selesai < $2::timestamp
         AND pm.kd_user_done IS NOT NULL
       GROUP BY pm.kd_user_done, p.nama_user
       ORDER BY jumlah DESC
       LIMIT 10`,
      [tglMulai, tglAkhirExclusive]
    );

    // ── Susun pesan ──────────────────────────────────────────────
    let pesan =
      `📊 *RINGKASAN LAPORAN — ${labelPeriode}*\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `📥 *Masuk periode ini* : ${totalMasuk}\n` +
      `   🟢 Open           : ${byStatus[0]}\n` +
      `   🟡 Proses         : ${byStatus[1]}\n` +
      `   ✅ Selesai        : ${byStatus[2]}\n` +
      `   🔴 Perlu TL       : ${byStatus[3]}\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `🔧 *Diproses pada periode ini*    : ${totalDiproses}\n` +
      `🏁 *Diselesaikan pada periode ini*: ${totalSelesai}\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `⏱️ *RESPONSE TIME* (masuk → mulai diproses)\n` +
      `   📈 Rata-rata     : ${totalRespon > 0 ? fmtMenit(rataRataMenit) : "-"}\n` +
      `   ⚡ < 10 menit    : ${jmlCepat} dari ${totalRespon} (${persenCepat}%)\n` +
      `   🐢 ≥ 10 menit    : ${jmlLambat} dari ${totalRespon} (${persenLambat}%)\n` +
      `━━━━━━━━━━━━━━━━━\n`;

    pesan += `🏆 *Top Petugas — Paling Banyak Memproses*\n`;
    if (!rankProsesRes.rows.length) {
      pesan += `   _(belum ada data pada periode ini)_\n`;
    } else {
      rankProsesRes.rows.forEach((r, i) => {
        pesan += `   ${i + 1}. ${r.nama} — ${r.jumlah} laporan\n`;
      });
    }

    pesan += `\n🏆 *Top Petugas — Paling Banyak Menyelesaikan*\n`;
    if (!rankDoneRes.rows.length) {
      pesan += `   _(belum ada data pada periode ini)_\n`;
    } else {
      rankDoneRes.rows.forEach((r, i) => {
        pesan += `   ${i + 1}. ${r.nama} — ${r.jumlah} laporan\n`;
      });
    }

    await kirimTeks(GRUP_NOTIF, pesan);
    console.log(`[SUM PERIODE] ✅ "${labelPeriode}" dikirim ke grup`);

    if (fromJid !== GRUP_NOTIF) {
      await kirimTeks(
        replyTo,
        `✅ Ringkasan ${labelPeriode} sudah dikirim ke grup notif.`
      );
    }
  } catch (err) {
    console.error("[SUM PERIODE] Error:", err.message);
    await kirimTeks(
      replyTo,
      `❌ Gagal membuat ringkasan ${labelPeriode}: ${err.message}`
    );
  }
}
// ================================================================
// Wrapper: #sumy<tahun> → ringkasan satu TAHUN penuh
// Contoh: #sumy2026 → 1 Jan 2026 s/d 31 Des 2026
// ================================================================
async function handleSumTahun(msg, senderJid, fromJid, tahun) {
  const tglMulai = `${tahun}-01-01`;
  const tglAkhir = `${tahun + 1}-01-01`;
  await handleSumPeriode(
    msg,
    senderJid,
    fromJid,
    tglMulai,
    tglAkhir,
    `TAHUN ${tahun}`
  );
}

// ================================================================
// Wrapper: #sum<bulan> → ringkasan satu BULAN (tahun berjalan)
// Contoh: #sum11 → November tahun berjalan
// ================================================================
async function handleSumBulan(msg, senderJid, fromJid, bulan, tahun) {
  if (bulan < 1 || bulan > 12) {
    await kirimTeks(
      fromJid,
      `❌ Bulan tidak valid. Gunakan angka 1-12, contoh: *#sum11* untuk November.`
    );
    return;
  }
  const bulanStr = String(bulan).padStart(2, "0");
  const tglMulai = `${tahun}-${bulanStr}-01`;
  const bulanBerikut = bulan === 12 ? 1 : bulan + 1;
  const tahunBerikut = bulan === 12 ? tahun + 1 : tahun;
  const tglAkhir = `${tahunBerikut}-${String(bulanBerikut).padStart(2, "0")}-01`;

  await handleSumPeriode(
    msg,
    senderJid,
    fromJid,
    tglMulai,
    tglAkhir,
    `BULAN ${NAMA_BULAN_ID[bulan]} ${tahun}`
  );
}

// ================================================================
// Wrapper: #sumt<triwulan> → ringkasan TRIWULAN (tahun berjalan)
// #sumt1 = Jan-Mar, #sumt2 = Apr-Jun, #sumt3 = Jul-Sep, #sumt4 = Okt-Des
// ================================================================
async function handleSumTriwulan(msg, senderJid, fromJid, triwulan, tahun) {
  if (triwulan < 1 || triwulan > 4) {
    await kirimTeks(
      fromJid,
      `❌ Triwulan tidak valid. Gunakan 1-4, contoh: *#sumt1* untuk Jan-Mar.`
    );
    return;
  }
  const bulanMulai = (triwulan - 1) * 3 + 1; // 1,4,7,10
  const bulanAkhir = bulanMulai + 3; // eksklusif, 4,7,10,13
  const tahunAkhir = bulanAkhir > 12 ? tahun + 1 : tahun;
  const bulanAkhirNormalisasi = bulanAkhir > 12 ? bulanAkhir - 12 : bulanAkhir;

  const tglMulai = `${tahun}-${String(bulanMulai).padStart(2, "0")}-01`;
  const tglAkhir = `${tahunAkhir}-${String(bulanAkhirNormalisasi).padStart(2, "0")}-01`;

  const namaBulanMulai = NAMA_BULAN_ID[bulanMulai];
  const namaBulanAkhir = NAMA_BULAN_ID[bulanMulai + 2];

  await handleSumPeriode(
    msg,
    senderJid,
    fromJid,
    tglMulai,
    tglAkhir,
    `TRIWULAN ${triwulan} ${tahun} (${namaBulanMulai}-${namaBulanAkhir})`
  );
}

// ================================================================
// Wrapper: #sums<semester> → ringkasan SEMESTER (tahun berjalan)
// #sums1 = Jan-Jun, #sums2 = Jul-Des
// ================================================================
async function handleSumSemester(msg, senderJid, fromJid, semester, tahun) {
  if (semester < 1 || semester > 2) {
    await kirimTeks(
      fromJid,
      `❌ Semester tidak valid. Gunakan 1 atau 2, contoh: *#sums1* untuk Jan-Jun.`
    );
    return;
  }
  const bulanMulai = semester === 1 ? 1 : 7;
  const bulanAkhir = semester === 1 ? 7 : 13; // eksklusif
  const tahunAkhir = bulanAkhir > 12 ? tahun + 1 : tahun;
  const bulanAkhirNormalisasi = bulanAkhir > 12 ? bulanAkhir - 12 : bulanAkhir;

  const tglMulai = `${tahun}-${String(bulanMulai).padStart(2, "0")}-01`;
  const tglAkhir = `${tahunAkhir}-${String(bulanAkhirNormalisasi).padStart(2, "0")}-01`;

  const namaBulanMulai = NAMA_BULAN_ID[bulanMulai];
  const namaBulanAkhir = NAMA_BULAN_ID[bulanMulai + 5];

  await handleSumPeriode(
    msg,
    senderJid,
    fromJid,
    tglMulai,
    tglAkhir,
    `SEMESTER ${semester} ${tahun} (${namaBulanMulai}-${namaBulanAkhir})`
  );
}
// ================================================================
// Helper: deteksi unit & divisi dari teks laporan
// ================================================================
// async function deteksiUnit(teks) {
//   try {
//     const { rows } = await pool.query(`SELECT kd_unit, nama_unit FROM unit`);
//     const lc = teks.toLowerCase().trim();
//     console.log(`[UNIT] Mencari unit dari teks: "${lc}"`);
//     const sorted = rows
//       .filter((r) => r.nama_unit && r.nama_unit.trim())
//       .sort((a, b) => b.nama_unit.length - a.nama_unit.length);
//     for (const r of sorted) {
//       const keyword = r.nama_unit.toLowerCase().trim();
//       if (fuzzyIncludes(lc, keyword)) {
//         console.log(`[UNIT] ✅ Cocok (fuzzy): "${keyword}" → kd_unit=${r.kd_unit}`);
//         return r.kd_unit;
//       }
//     }
//     console.log(`[UNIT] ❌ Tidak ada unit yang cocok`);
//     return null;
//   } catch (e) {
//     console.error(`[UNIT] Error:`, e.message);
//     return null;
//   }
// }

// async function deteksiUnit(teks) {
//   try {
//     const { rows } = await pool.query(
//       `SELECT kd_unit, keyword FROM keyword_unit WHERE status_aktif = 1 ORDER BY LENGTH(keyword) DESC`
//     );
//     const lc = teks.toLowerCase().trim();
//     console.log(`[UNIT] Mencari unit dari teks: "${lc}"`);

//     for (const r of rows) {
//       if (!r.keyword || !r.keyword.trim()) continue;
//       const keyword = r.keyword.toLowerCase().trim();
//       if (fuzzyIncludes(lc, keyword)) {
//         console.log(`[UNIT] ✅ Cocok (fuzzy): "${keyword}" → kd_unit=${r.kd_unit}`);
//         return r.kd_unit;
//       }
//     }
//     console.log(`[UNIT] ❌ Tidak ada unit yang cocok`);
//     return null;
//   } catch (e) {
//     console.error(`[UNIT] Error:`, e.message);
//     return null;
//   }
// }
// Cari unit dengan match PALING AWAL di dalam teks (bukan berdasarkan
// urutan keyword di DB / panjang keyword). Kalau ada beberapa keyword
// yang sama-sama mulai cocok di posisi yang sama, prioritaskan yang
// EXACT match dulu, baru kalau exact-nya sama-sama ada, pilih yang
// keyword-nya lebih panjang/spesifik.
// function cariUnitTerawal(teksWords, keywordRows) {
//   const keywordsParsed = keywordRows
//     .filter((r) => r.keyword && r.keyword.trim())
//     .map((r) => ({
//       kd_unit: r.kd_unit,
//       keyword: r.keyword.toLowerCase().trim(),
//       words: r.keyword.toLowerCase().trim().split(/\s+/).filter(Boolean),
//     }));

//   for (let i = 0; i < teksWords.length; i++) {
//     const kandidat = [];

//     for (const kw of keywordsParsed) {
//       const n = kw.words.length;
//       if (i + n > teksWords.length) continue;

//       let cocokSemua = true;
//       let exact = true;

//       for (let j = 0; j < n; j++) {
//         const kataTeks = teksWords[i + j];
//         const kataKeyword = kw.words[j];
//         if (kataTeks === kataKeyword) continue;
//         exact = false;
//         const dist = levenshteinDistance(kataTeks, kataKeyword);
//         if (dist > toleransiEdit(kataKeyword.length)) {
//           cocokSemua = false;
//           break;
//         }
//       }

//       if (cocokSemua) {
//         kandidat.push({ kd_unit: kw.kd_unit, keyword: kw.keyword, exact });
//       }
//     }

//     if (kandidat.length > 0) {
//       // di posisi yang sama: exact match menang lebih dulu,
//       // baru kalau semuanya fuzzy, ambil keyword terpanjang (lebih spesifik)
//       kandidat.sort((a, b) => {
//         if (a.exact !== b.exact) return a.exact ? -1 : 1;
//         return b.keyword.length - a.keyword.length;
//       });
//       const pilihan = kandidat[0];
//       console.log(
//         `[UNIT] ✅ Match terawal di posisi kata ke-${i}: "${pilihan.keyword}" ` +
//           `(${pilihan.exact ? "exact" : "fuzzy"}) → kd_unit=${pilihan.kd_unit}`
//       );
//       return pilihan.kd_unit;
//     }
//   }
//   return null;
// }
// ================================================================
// Handler: #info
// Menampilkan daftar SEMUA command yang tersedia di bot, dikelompokkan
// per kategori. Bisa dipicu dari mana saja; balasannya dikirim ke
// tempat command diketik (bukan selalu ke GRUP_NOTIF), karena ini
// murni informasi, bukan data laporan.
// ================================================================
async function handleInfo(msg, senderJid, fromJid) {
  console.log(`[INFO] diminta oleh ${senderJid} dari ${fromJid}`);
  await tandaiDibaca([msg.key]);

  const pesan =
    `🤖 *DAFTAR PERINTAH BOT HELPDESK IT*\n` +
    `━━━━━━━━━━━━━━━━━\n\n` +

    `📝 *LAPOR & TINDAK LANJUT*\n` +
    `• *#laporsimrs* <isi masalah>\n   Membuat laporan baru. Bisa disertai foto/video/dokumen sebagai lampiran.\n\n` +
    `• *#proses<ID>*\n   Menandai laporan sedang diproses. Contoh: *#proses12*\n\n` +
    `• *#done<ID>* [solusi]\n   Menandai laporan selesai + kirim solusi ke pelapor. Contoh: *#done12 sudah diganti kabel LAN*\n\n` +
    `• *#up<ID>* [alasan]\n   Menandai laporan perlu eskalasi/tindak lanjut lebih lanjut. Contoh: *#up12 menunggu sparepart*\n\n` +
    `• *#gantiunit* <nama unit>\n   Mengubah unit/ruangan Anda sendiri di sistem. Contoh: *#gantiunit Rawamerta*\n\n` +
    `• *#daftar* <nomor HP>\n   Mendaftarkan nomor HP Anda (khusus akun yang terdeteksi LID). Contoh: *#daftar 08123456789*\n\n` +

    `━━━━━━━━━━━━━━━━━\n` +
    `📋 *DAFTAR LAPORAN BELUM SELESAI (OPEN/PROSES)*\n` +
    `• *#cekopen* — Semua laporan belum selesai (tanpa batas tanggal)\n` +
    `• *#opentoday* — Belum selesai yang masuk hari ini\n` +
    `• *#open<bulan 1-12>* — Belum selesai pada bulan tsb (tahun berjalan). Contoh: *#open11*\n` +
    `• *#opent<1-4>* — Belum selesai per triwulan (tahun berjalan): 1=Jan-Mar, 2=Apr-Jun, 3=Jul-Sep, 4=Okt-Des\n` +
    `• *#opens<1-2>* — Belum selesai per semester (tahun berjalan): 1=Jan-Jun, 2=Jul-Des\n` +
    `• *#openy<tahun>* — Belum selesai sepanjang tahun tsb. Contoh: *#openy2026*\n\n` +

    `━━━━━━━━━━━━━━━━━\n` +
    `📊 *RINGKASAN & STATISTIK*\n` +
    `• *#sum* — Ringkasan hari ini (masuk, proses, selesai + ranking petugas)\n` +
    `• *#sum<bulan 1-12>* — Ringkasan bulan tsb (tahun berjalan). Contoh: *#sum11*\n` +
    `• *#sumt<1-4>* — Ringkasan per triwulan (tahun berjalan): 1=Jan-Mar, 2=Apr-Jun, 3=Jul-Sep, 4=Okt-Des\n` +
    `• *#sums<1-2>* — Ringkasan per semester (tahun berjalan): 1=Jan-Jun, 2=Jul-Des\n` +
    `• *#sumy<tahun>* — Ringkasan satu tahun penuh. Contoh: *#sumy2026*\n` +
    `• *#sumall* — Ringkasan keseluruhan sepanjang riwayat database\n\n` +

    `━━━━━━━━━━━━━━━━━\n` +
    `ℹ️ *LAIN-LAIN*\n` +
    `• *#info* — Menampilkan daftar perintah ini\n\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `💡 Ketik ID laporan tanpa tanda pagar di dalam command, contoh: *#proses12*, bukan *#proses #12*`;

  await kirimTeks(fromJid, pesan);
  console.log(`[INFO] ✅ Daftar perintah dikirim ke ${fromJid}`);
}

function cariUnitTerawal(teksWords, keywordRows) {
  const keywordsParsed = keywordRows
    .filter((r) => r.keyword && r.keyword.trim())
    .map((r) => ({
      kd_unit: r.kd_unit,
      keyword: r.keyword.toLowerCase().trim(),
      words: r.keyword.toLowerCase().trim().split(/\s+/).filter(Boolean),
    }));

  // ---------- PASS 1: EXACT MATCH di seluruh teks dulu ----------
  // Scan semua posisi kata cari yang cocok PERSIS. Baru berhenti kalau
  // ketemu — supaya exact match yang letaknya belakangan tidak kalah
  // sama fuzzy match yang kebetulan nongol lebih awal.
  for (let i = 0; i < teksWords.length; i++) {
    const kandidatExact = [];

    for (const kw of keywordsParsed) {
      const n = kw.words.length;
      if (i + n > teksWords.length) continue;

      let cocokExact = true;
      for (let j = 0; j < n; j++) {
        if (teksWords[i + j] !== kw.words[j]) {
          cocokExact = false;
          break;
        }
      }
      if (cocokExact) {
        kandidatExact.push({ kd_unit: kw.kd_unit, keyword: kw.keyword });
      }
    }

    if (kandidatExact.length > 0) {
      // beberapa keyword exact nyangkut di posisi sama → ambil yang lebih spesifik (lebih panjang)
      kandidatExact.sort((a, b) => b.keyword.length - a.keyword.length);
      const pilihan = kandidatExact[0];
      console.log(
        `[UNIT] ✅ EXACT match di posisi kata ke-${i}: "${pilihan.keyword}" → kd_unit=${pilihan.kd_unit}`
      );
      return pilihan.kd_unit;
    }
  }

  // ---------- PASS 2: FUZZY MATCH — HANYA kalau PASS 1 nihil total ----------
  console.log(`[UNIT] ⚠ Tidak ada exact match sama sekali, coba fuzzy...`);

  for (let i = 0; i < teksWords.length; i++) {
    const kandidatFuzzy = [];

    for (const kw of keywordsParsed) {
      const n = kw.words.length;
      if (i + n > teksWords.length) continue;

      let cocokSemua = true;
      for (let j = 0; j < n; j++) {
        const kataTeks = teksWords[i + j];
        const kataKeyword = kw.words[j];
        const dist = levenshteinDistance(kataTeks, kataKeyword);
        if (dist > toleransiEdit(kataKeyword.length)) {
          cocokSemua = false;
          break;
        }
      }
      if (cocokSemua) {
        kandidatFuzzy.push({ kd_unit: kw.kd_unit, keyword: kw.keyword });
      }
    }

    if (kandidatFuzzy.length > 0) {
      kandidatFuzzy.sort((a, b) => b.keyword.length - a.keyword.length);
      const pilihan = kandidatFuzzy[0];
      console.log(
        `[UNIT] ✅ FUZZY match di posisi kata ke-${i}: "${pilihan.keyword}" → kd_unit=${pilihan.kd_unit}`
      );
      return pilihan.kd_unit;
    }
  }

  return null;
}

async function deteksiUnit(teks) {
  try {
    const { rows } = await pool.query(
      `SELECT kd_unit, keyword FROM keyword_unit WHERE status_aktif = 1`
    );
    // const lc = teks.toLowerCase().trim();
      const lc = teks.toLowerCase().trim()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")   // buang tanda baca, ganti spasi
      .replace(/\s+/g, " ")
      .trim();
    const teksWords = lc.split(/\s+/).filter(Boolean);
    console.log(`[UNIT] Mencari unit dari teks: "${lc}"`);

    const hasil = cariUnitTerawal(teksWords, rows);
    if (!hasil) console.log(`[UNIT] ❌ Tidak ada unit yang cocok`);
    return hasil;
  } catch (e) {
    console.error(`[UNIT] Error:`, e.message);
    return null;
  }
}

// async function deteksiDivisi(teks) {
//   try {
//     const { rows } = await pool.query(
//       `SELECT kd_divisi, keyword FROM keyword_divisi ORDER BY LENGTH(keyword) DESC`
//     );
//     const lc = teks.toLowerCase();
//     for (const r of rows) {
//       if (fuzzyIncludes(lc, r.keyword.toLowerCase())) return r.kd_divisi;
//     }
//     return null;
//   } catch {
//     return null;
//   }
// }

// ================================================================
// Helper: deteksi divisi + kategori spesifik (kd_mapping_divisi)
// sekaligus, dari satu query ke keyword_divisi.
// ================================================================
async function deteksiDivisiMapping(teks) {
  try {
    const { rows } = await pool.query(
      `SELECT kd_divisi, kd_mapping_divisi, keyword
       FROM keyword_divisi ORDER BY LENGTH(keyword) DESC`
    );
    const lc = teks.toLowerCase();
    for (const r of rows) {
      if (r.keyword && fuzzyIncludes(lc, r.keyword.toLowerCase())) {
        console.log(
          `[MAPPING] ✅ Cocok: "${r.keyword}" → kd_divisi=${r.kd_divisi}, kd_mapping_divisi=${r.kd_mapping_divisi}`
        );
        return { kdDivisi: r.kd_divisi, kdMappingDivisi: r.kd_mapping_divisi };
      }
    }
    return { kdDivisi: null, kdMappingDivisi: null };
  } catch (e) {
    console.warn("[MAPPING] Error:", e.message);
    return { kdDivisi: null, kdMappingDivisi: null };
  }
}

// Dipertahankan agar pemanggil lama tidak perlu diubah
async function deteksiDivisi(teks) {
  const { kdDivisi } = await deteksiDivisiMapping(teks);
  return kdDivisi;
}

async function getNamaDivisi(kdDivisi) {
  if (!kdDivisi) return "Tidak Terdeteksi";
  try {
    const r = await pool.query(`SELECT name FROM divisi WHERE kd_divisi=$1`, [
      kdDivisi,
    ]);
    return r.rows[0]?.name || "Tidak Terdeteksi";
  } catch {
    return "Tidak Terdeteksi";
  }
}

// ================================================================
// Cek & siapkan kolom tabel
// ================================================================
async function cekStrukturTabel() {
  let cols = [];
  try {
    const r = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='pesan_masuk'`
    );
    cols = r.rows.map((x) => x.column_name);
    console.log("[DB] Kolom pesan_masuk:", cols.join(", "));
  } catch (e) {
    console.error("[DB] Gagal baca kolom:", e.message);
  }

  for (const { col, def } of [
    { col: "attachments", def: "TEXT[] DEFAULT '{}'" },
    { col: "kd_divisi", def: "INT4 REFERENCES divisi(kd_divisi)" },
    { col: "chat_id", def: "VARCHAR" },
    { col: "status_hapus", def: "INT2 DEFAULT 0" },
    { col: "attachments_done", def: "TEXT[] DEFAULT '{}'" },
    { col: "kd_user_proses", def: "INT4" },
    { col: "kd_user_done", def: "INT4" },
    { col: "kd_user_up", def: "INT4" },
    { col: "tgl_up", def: "TIMESTAMP" },
    { col: "kd_unit_pelapor", def: "INT4" },
     { col: "kd_mapping_divisi", def: "INT4 REFERENCES mapping_divisi(kd_mapping_divisi)" }, // BARU
  ]) {
    if (!cols.includes(col)) {
      try {
        await pool.query(`ALTER TABLE pesan_masuk ADD COLUMN ${col} ${def}`);
        console.log(`[DB] +${col}`);
      } catch (e) {
        console.warn(`[DB] pesan_masuk.${col}:`, e.message);
      }
    }
  }
  dbCache.colWaktu = cols.includes("tgl_lapor") ? "tgl_lapor" : "timestamp";
  console.log("[DB] Kolom waktu:", dbCache.colWaktu);

  let cols2 = [];
  try {
    const r2 = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='kirim_wa'`
    );
    cols2 = r2.rows.map((x) => x.column_name);
  } catch (e) {
    console.error("[DB] Gagal baca kolom kirim_wa:", e.message);
  }

  for (const { col, def } of [
    { col: "kd_user", def: "INT4" },
    { col: "id_pesan_masuk", def: "INT4" },
    { col: "solusi", def: "TEXT" },
    { col: "retry_count", def: "INT2 DEFAULT 0" },
  ]) {
    if (!cols2.includes(col)) {
      try {
        await pool.query(`ALTER TABLE kirim_wa ADD COLUMN ${col} ${def}`);
        console.log(`[DB] +${col}`);
      } catch (e) {
        console.warn(`[DB] kirim_wa.${col}:`, e.message);
      }
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
    const buf = await downloadMediaMessage(
      msg,
      "buffer",
      {},
      {
        logger: pino({ level: "silent" }),
        reuploadRequest: sockGlobal.updateMediaMessage,
      }
    );
    if (!buf) return null;
    const mime = msg.message?.[msgType]?.mimetype || "application/octet-stream";
    const extMap = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/gif": "gif",
      "image/webp": "webp",
      "video/mp4": "mp4",
      "video/3gpp": "3gp",
      "video/quicktime": "mov",
      "audio/ogg": "ogg",
      "audio/mpeg": "mp3",
      "application/pdf": "pdf",
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

// Helper: resolve nomor admin (pengirim command), bukan pelapor
async function resolveAdminUntukKdUser(senderJid, groupJid, pushName) {
  let nomorAdmin = null;
  let lidAdmin = null;

  if (senderJid.endsWith("@s.whatsapp.net") || senderJid.endsWith("@c.us")) {
    nomorAdmin = normalizeNomor(senderJid);
  } else if (senderJid.endsWith("@lid")) {
    lidAdmin = senderJid;
    nomorAdmin = await resolveNomorDariGrup(sockGlobal, groupJid, lidAdmin);
    if (!nomorAdmin) {
      const cek = await pool.query(
        `SELECT nomor_hp FROM pengguna WHERE whatsapp_lid=$1 AND nomor_hp IS NOT NULL LIMIT 1`,
        [lidAdmin]
      );
      if (cek.rows.length) nomorAdmin = cek.rows[0].nomor_hp;
    }
  }

  const namaAdmin = isNamaValid(pushName)
    ? pushName.trim()
    : nomorAdmin || lidAdmin;
  return ambilAtauBuatKdUser(nomorAdmin || lidAdmin, namaAdmin);
}

// ================================================================
// Handler: #proses<id>
// ================================================================
async function handleProses(msg, idPesan, senderJid) {
  console.log(`[PROSES] #proses${idPesan} dari ${senderJid}`);
  const replyTo = msg.key.remoteJid;
  await tandaiDibaca([msg.key]);
  try {
    const { rows } = await pool.query(
      `SELECT id, pengirim, nomor_pengirim, chat_id FROM pesan_masuk WHERE id=$1`,
      [idPesan]
    );
    if (!rows.length) {
      await kirimTeks(replyTo, `❌ Laporan #${idPesan} tidak ditemukan.`);
      return;
    }

    const lap = rows[0];
    const kdUser = await resolveAdminUntukKdUser(
      senderJid,
      msg.key.remoteJid,
      msg.pushName
    );

    await pool.query(
      `UPDATE pesan_masuk SET status_selesai=1, tgl_proses=LOCALTIMESTAMP(0), kd_user_proses=$1 WHERE id=$2`,
      [kdUser, idPesan]
    );

    console.log(
      `[PROSES] ✅ ID ${idPesan} (kd_user_proses=${kdUser}, tanpa notifikasi)`
    );
  } catch (err) {
    console.error("[PROSES] Error:", err.message);
    await kirimTeks(replyTo, `❌ Gagal: ${err.message}`);
  }
}

// ================================================================
// Handler: #done<id> [solusi]
// Sekarang mendukung lampiran (foto/dokumen/video) yang dikirim
// bersamaan dengan command #done — disimpan ke pesan_masuk.attachments_done
// dan otomatis diteruskan ke pelapor + grup notif.
// ================================================================
async function handleDone(
  msg,
  idPesan,
  pesanSolusi,
  senderJid,
  attachments = []
) {
  console.log(
    `[DONE] #done${idPesan} dari ${senderJid} (lampiran: ${attachments.length})`
  );
  const replyTo = msg.key.remoteJid;
  await tandaiDibaca([msg.key]);
  try {
    const { rows } = await pool.query(
      `SELECT id, pengirim, nomor_pengirim, chat_id FROM pesan_masuk WHERE id=$1`,
      [idPesan]
    );
    if (!rows.length) {
      await kirimTeks(replyTo, `❌ Laporan #${idPesan} tidak ditemukan.`);
      return;
    }

    const lap = rows[0];
    const pesanUser =
      `Halo *${lap.pengirim}*, laporan Anda dengan ID ticket *${lap.id}*, telah *diselesaikan*. Terima kasih sudah melapor. 🙏`;
      //  +
      // (attachments.length
      //   ? `\n\n📎 Bukti penyelesaian terlampir (${attachments.length} file).`
      //   : "");

    const kdUser = await resolveAdminUntukKdUser(
      senderJid,
      msg.key.remoteJid,
      msg.pushName
    );

    // await pool.query(
    //   `UPDATE pesan_masuk SET status_selesai=2, tgl_selesai=LOCALTIMESTAMP(0), kd_user_done=$1, attachments_done=$2 WHERE id=$3`,
    //   [kdUser, attachments, idPesan]
    // );

    //   let kdDivisiDariSolusi = null;
    // if (pesanSolusi && pesanSolusi.trim()) {
    //   try {
    //     kdDivisiDariSolusi = await deteksiDivisi(pesanSolusi);
    //     if (kdDivisiDariSolusi) {
    //       console.log(
    //         `[DONE][DIVISI] Terdeteksi dari solusi "#done${idPesan}": kd_divisi=${kdDivisiDariSolusi}`
    //       );
    //     }
    //   } catch (e) {
    //     console.warn(`[DONE][DIVISI] Gagal deteksi:`, e.message);
    //   }
    // }

    // if (kdDivisiDariSolusi) {
    //   await pool.query(
    //     `UPDATE pesan_masuk
    //      SET status_selesai=2, tgl_selesai=LOCALTIMESTAMP(0),
    //          kd_user_done=$1, attachments_done=$2, kd_divisi=$3
    //      WHERE id=$4`,
    //     [kdUser, attachments, kdDivisiDariSolusi, idPesan]
    //   );
    // } else {
    //   await pool.query(
    //     `UPDATE pesan_masuk
    //      SET status_selesai=2, tgl_selesai=LOCALTIMESTAMP(0),
    //          kd_user_done=$1, attachments_done=$2
    //      WHERE id=$3`,
    //     [kdUser, attachments, idPesan]
    //   );
    // }
        // ====== Deteksi ulang divisi + kategori dari teks solusi #done ======
    let kdDivisiDariSolusi = null;
    let kdMappingDivisiDariSolusi = null;
    if (pesanSolusi && pesanSolusi.trim()) {
      try {
        const hasil = await deteksiDivisiMapping(pesanSolusi);
        kdDivisiDariSolusi = hasil.kdDivisi;
        kdMappingDivisiDariSolusi = hasil.kdMappingDivisi;
        if (kdDivisiDariSolusi) {
          console.log(
            `[DONE][DIVISI] Terdeteksi dari solusi "#done${idPesan}": kd_divisi=${kdDivisiDariSolusi}, kd_mapping_divisi=${kdMappingDivisiDariSolusi}`
          );
        }
      } catch (e) {
        console.warn(`[DONE][DIVISI] Gagal deteksi:`, e.message);
      }
    }

    if (kdDivisiDariSolusi) {
      await pool.query(
        `UPDATE pesan_masuk
         SET status_selesai=2, tgl_selesai=LOCALTIMESTAMP(0),
             kd_user_done=$1, attachments_done=$2, kd_divisi=$3, kd_mapping_divisi=$4
         WHERE id=$5`,
        [kdUser, attachments, kdDivisiDariSolusi, kdMappingDivisiDariSolusi, idPesan]
      );
    } else {
      await pool.query(
        `UPDATE pesan_masuk
         SET status_selesai=2, tgl_selesai=LOCALTIMESTAMP(0),
             kd_user_done=$1, attachments_done=$2
         WHERE id=$3`,
        [kdUser, attachments, idPesan]
      );
    }
    // =========================================================================

    const tujuan = await getTujuan(idPesan);
    if (!tujuan) {
      console.warn(`[DONE] Tujuan tidak ditemukan untuk #${idPesan}`);
      await kirimTeks(
        replyTo,
        `⚠️ Laporan #${idPesan} selesai, tapi tujuan user tidak ditemukan.`
      );
    } else {
      const berhasil = await kirimLangsungKeUser(tujuan, pesanUser);
      await antrikanKirim({
        nomor_pengirim: tujuan,
        kd_user: kdUser,
        isi_pesan: pesanUser,
        solusi: pesanSolusi,
        id_pesan_masuk: idPesan,
        status_kirim: berhasil ? 1 : 0,
      });

      // Kirim lampiran bukti penyelesaian ke pelapor
      // for (let i = 0; i < attachments.length; i++) {
      //   await kirimFile(
      //     tujuan,
      //     path.join(__dirname, attachments[i]),
      //     `📎 Bukti penyelesaian ${i + 1}/${attachments.length} — #${idPesan}`
      //   ).catch((e) =>
      //     console.warn(
      //       `[DONE] Gagal kirim lampiran ke user ${i + 1}:`,
      //       e.message
      //     )
      //   );
      // }
    }
  } catch (err) {
    console.error("[DONE] Error:", err.message);
    await kirimTeks(replyTo, `❌ Gagal: ${err.message}`);
  }
}

async function handleUp(msg, idPesan, alasan, senderJid) {
  console.log(`[UP] #up${idPesan} dari ${senderJid}`);
  const replyTo = msg.key.remoteJid;
  await tandaiDibaca([msg.key]);
  try {
    const { rows } = await pool.query(
      `SELECT id, pengirim, nomor_pengirim, chat_id FROM pesan_masuk WHERE id=$1`,
      [idPesan]
    );
    if (!rows.length) {
      await kirimTeks(replyTo, `❌ Laporan #${idPesan} tidak ditemukan.`);
      return;
    }

    const lap = rows[0];
    const kdUser = await resolveAdminUntukKdUser(
      senderJid,
      msg.key.remoteJid,
      msg.pushName
    );

    await pool.query(
      `UPDATE pesan_masuk
       SET status_selesai=3, tgl_up=LOCALTIMESTAMP(0), kd_user_up=$1
       WHERE id=$2`,
      [kdUser, idPesan]
    );

    const pesanUser =
      `Halo *${lap.pengirim}*, laporan Anda dengan ID ticket *${lap.id}* ` +
      `*belum dapat diselesaikan* saat ini dan memerlukan tindak lanjut/konsultasi lebih lanjut.\n` +
      (alasan ? `\n📝 *Keterangan:* ${alasan}\n` : "") +
      `\nTim kami akan menginformasikan perkembangannya. Mohon menunggu. 🙏`;

    const tujuan = await getTujuan(idPesan);
    if (!tujuan) {
      console.warn(`[UP] Tujuan tidak ditemukan untuk #${idPesan}`);
      await kirimTeks(
        replyTo,
        `⚠️ Laporan #${idPesan} ditandai eskalasi, tapi tujuan user tidak ditemukan.`
      );
    } else {
      const berhasil = await kirimLangsungKeUser(tujuan, pesanUser);
      await antrikanKirim({
        nomor_pengirim: tujuan,
        kd_user: kdUser,
        isi_pesan: pesanUser,
        solusi: alasan,
        id_pesan_masuk: idPesan,
        status_kirim: berhasil ? 1 : 0,
      });
    }
  } catch (err) {
    console.error("[UP] Error:", err.message);
    await kirimTeks(replyTo, `❌ Gagal: ${err.message}`);
  }
}

// ================================================================
// Handler: #sumall
// Sama seperti #sum, tapi untuk KESELURUHAN data sepanjang waktu
// (tidak difilter tanggal). Berguna untuk melihat rekap total sejak
// sistem digunakan: total masuk, breakdown status saat ini, total
// yang pernah diproses & diselesaikan, plus ranking petugas
// sepanjang masa.
// ================================================================
async function handleSumAll(msg, senderJid, fromJid) {
  console.log(`[SUMALL] diminta oleh ${senderJid} dari ${fromJid}`);
  const replyTo = fromJid;
  await tandaiDibaca([msg.key]);
  try {
    // 1) Total laporan masuk (semua waktu) + breakdown status saat ini
    const masukRes = await pool.query(
      `SELECT status_selesai, COUNT(*) AS jumlah
       FROM pesan_masuk
       WHERE (status_hapus IS NULL OR status_hapus = 0)
       GROUP BY status_selesai`
    );
    const totalMasuk = masukRes.rows.reduce(
      (a, r) => a + parseInt(r.jumlah),
      0
    );
    const byStatus = { 0: 0, 1: 0, 2: 0, 3: 0 };
    for (const r of masukRes.rows) {
      byStatus[r.status_selesai] = parseInt(r.jumlah);
    }

    // 2) Total yang PERNAH diproses (tgl_proses terisi)
    const prosesRes = await pool.query(
      `SELECT COUNT(*) AS jumlah
       FROM pesan_masuk
       WHERE (status_hapus IS NULL OR status_hapus = 0)
         AND tgl_proses IS NOT NULL`
    );
    const totalDiproses = parseInt(prosesRes.rows[0]?.jumlah || 0);

    // 3) Total yang PERNAH diselesaikan (tgl_selesai terisi)
    const selesaiRes = await pool.query(
      `SELECT COUNT(*) AS jumlah
       FROM pesan_masuk
       WHERE (status_hapus IS NULL OR status_hapus = 0)
         AND tgl_selesai IS NOT NULL`
    );
    const totalSelesai = parseInt(selesaiRes.rows[0]?.jumlah || 0);

    // 4) Rentang tanggal data (laporan pertama & terakhir masuk)
    const colWaktu = dbCache.colWaktu || "timestamp";
    const rentangRes = await pool.query(
      `SELECT MIN(${colWaktu}) AS awal, MAX(${colWaktu}) AS akhir
       FROM pesan_masuk
       WHERE (status_hapus IS NULL OR status_hapus = 0)`
    );
    const fmtTgl = (d) =>
      d
        ? new Date(d).toLocaleString("id-ID", {
            timeZone: "Asia/Jakarta",
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
          })
        : "-";
    const tglAwal = fmtTgl(rentangRes.rows[0]?.awal);
    const tglAkhir = fmtTgl(rentangRes.rows[0]?.akhir);

    // ================================================================
    // 4.5) RESPONSE TIME — selisih waktu MASUK sampai MULAI DIPROSES
    // (tgl_proses - waktu masuk), untuk SELURUH riwayat data. Dalam MENIT.
    // ================================================================
    const responTimeRes = await pool.query(
      `SELECT
         EXTRACT(EPOCH FROM (tgl_proses - ${colWaktu})) / 60 AS menit_respon
       FROM pesan_masuk
       WHERE (status_hapus IS NULL OR status_hapus = 0)
         AND tgl_proses IS NOT NULL
         AND ${colWaktu} IS NOT NULL`
    );

    const daftarMenit = responTimeRes.rows
      .map((r) => parseFloat(r.menit_respon))
      .filter((m) => !isNaN(m) && m >= 0);

    const totalRespon = daftarMenit.length;
    const rataRataMenit =
      totalRespon > 0
        ? daftarMenit.reduce((a, b) => a + b, 0) / totalRespon
        : 0;
    const jmlCepat = daftarMenit.filter((m) => m < 10).length;
    const jmlLambat = daftarMenit.filter((m) => m >= 10).length;
    const persenCepat =
      totalRespon > 0 ? ((jmlCepat / totalRespon) * 100).toFixed(1) : "0.0";
    const persenLambat =
      totalRespon > 0 ? ((jmlLambat / totalRespon) * 100).toFixed(1) : "0.0";

    const fmtMenit = (menit) => {
      if (menit < 60) return `${menit.toFixed(1)} menit`;
      const jam = Math.floor(menit / 60);
      const sisaMenit = Math.round(menit % 60);
      return `${jam} jam ${sisaMenit} menit`;
    };

    // 5) Ranking petugas paling banyak MEMPROSES (sepanjang masa)
    const rankProsesRes = await pool.query(
      `SELECT pm.kd_user_proses AS kd_user, COALESCE(p.nama_user, 'Tidak diketahui') AS nama,
              COUNT(*) AS jumlah
       FROM pesan_masuk pm
       LEFT JOIN pengguna p ON p.kd_user = pm.kd_user_proses
       WHERE (pm.status_hapus IS NULL OR pm.status_hapus = 0)
         AND pm.kd_user_proses IS NOT NULL
       GROUP BY pm.kd_user_proses, p.nama_user
       ORDER BY jumlah DESC
       LIMIT 10`
    );

    // 6) Ranking petugas paling banyak MENYELESAIKAN (sepanjang masa)
    const rankDoneRes = await pool.query(
      `SELECT pm.kd_user_done AS kd_user, COALESCE(p.nama_user, 'Tidak diketahui') AS nama,
              COUNT(*) AS jumlah
       FROM pesan_masuk pm
       LEFT JOIN pengguna p ON p.kd_user = pm.kd_user_done
       WHERE (pm.status_hapus IS NULL OR pm.status_hapus = 0)
         AND pm.kd_user_done IS NOT NULL
       GROUP BY pm.kd_user_done, p.nama_user
       ORDER BY jumlah DESC
       LIMIT 10`
    );

    // ── Susun pesan ──────────────────────────────────────────────
    let pesan =
      `📊 *RINGKASAN KESELURUHAN LAPORAN*\n` +
      `🗓️ Data: ${tglAwal} s/d ${tglAkhir}\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `📥 *Total masuk*      : ${totalMasuk}\n` +
      `   🟢 Open           : ${byStatus[0]}\n` +
      `   🟡 Proses         : ${byStatus[1]}\n` +
      `   ✅ Selesai        : ${byStatus[2]}\n` +
      `   🔴 Perlu TL       : ${byStatus[3]}\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `🔧 *Total pernah diproses*    : ${totalDiproses}\n` +
      `🏁 *Total pernah diselesaikan*: ${totalSelesai}\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `⏱️ *RESPONSE TIME* (masuk → mulai diproses, all time)\n` +
      `   📈 Rata-rata     : ${totalRespon > 0 ? fmtMenit(rataRataMenit) : "-"}\n` +
      `   ⚡ < 10 menit    : ${jmlCepat} dari ${totalRespon} (${persenCepat}%)\n` +
      `   🐢 ≥ 10 menit    : ${jmlLambat} dari ${totalRespon} (${persenLambat}%)\n` +
      `━━━━━━━━━━━━━━━━━\n`;

    pesan += `🏆 *Top Petugas — Paling Banyak Memproses (All Time)*\n`;
    if (!rankProsesRes.rows.length) {
      pesan += `   _(belum ada data)_\n`;
    } else {
      rankProsesRes.rows.forEach((r, i) => {
        pesan += `   ${i + 1}. ${r.nama} — ${r.jumlah} laporan\n`;
      });
    }

    pesan += `\n🏆 *Top Petugas — Paling Banyak Menyelesaikan (All Time)*\n`;
    if (!rankDoneRes.rows.length) {
      pesan += `   _(belum ada data)_\n`;
    } else {
      rankDoneRes.rows.forEach((r, i) => {
        pesan += `   ${i + 1}. ${r.nama} — ${r.jumlah} laporan\n`;
      });
    }

    await kirimTeks(GRUP_NOTIF, pesan);
    console.log(`[SUMALL] ✅ Ringkasan keseluruhan dikirim ke grup`);

    if (fromJid !== GRUP_NOTIF) {
      await kirimTeks(
        replyTo,
        `✅ Ringkasan keseluruhan sudah dikirim ke grup notif.`
      );
    }
  } catch (err) {
    console.error("[SUMALL] Error:", err.message);
    await kirimTeks(
      replyTo,
      `❌ Gagal membuat ringkasan keseluruhan: ${err.message}`
    );
  }
}

// ================================================================
// Handler: #gantiunit <nama unit>
// Dipakai oleh PELAPOR sendiri untuk mengubah kd_unit di tabel
// pengguna secara manual. Nama unit dicocokkan pakai deteksiUnit()
// yang sama (exact-first, fuzzy fallback) supaya toleran typo.
// ================================================================
async function handleGantiUnit(msg, namaUnitInput, senderJid, fromJid) {
  console.log(`[GANTI UNIT] "${namaUnitInput}" dari ${senderJid}`);
  const replyTo = fromJid;

  if (!namaUnitInput || !namaUnitInput.trim()) {
    await kirimTeks(
      replyTo,
      `❌ Format salah. Contoh: *#gantiunit Rawamerta*`
    );
    return;
  }

  try {
    const kdUnitBaru = await deteksiUnit(namaUnitInput.trim());
    if (!kdUnitBaru) {
      await kirimTeks(
        replyTo,
        `❌ Unit "*${namaUnitInput.trim()}*" tidak ditemukan/tidak dikenali. Pastikan nama unit sesuai daftar unit RS.`
      );
      return;
    }

    // Resolve identitas pengirim (nomor HP atau LID) — sama seperti #daftar
    let nomorUser = null;
    let lidValue = null;

    if (isGroup(fromJid)) {
      if (
        senderJid.endsWith("@s.whatsapp.net") ||
        senderJid.endsWith("@c.us")
      ) {
        nomorUser = normalizeNomor(senderJid);
      } else if (senderJid.endsWith("@lid")) {
        lidValue = senderJid;
        nomorUser = await resolveNomorDariGrup(sockGlobal, fromJid, lidValue);
      }
    } else if (isLid(fromJid)) {
      lidValue = fromJid;
    } else {
      nomorUser = normalizeNomor(fromJid);
    }

    if (!nomorUser && !lidValue) {
      await kirimTeks(
        replyTo,
        `❌ Gagal mengenali identitas Anda, coba lagi atau daftar dulu dengan *#daftar <nomor>*.`
      );
      return;
    }

    // Coba update berdasarkan nomor dulu, kalau tidak ada row coba via LID
    let updateResult = null;
    if (nomorUser) {
      updateResult = await pool.query(
        `UPDATE pengguna SET kd_unit=$1 WHERE nomor_hp=$2 RETURNING kd_unit, nama_user`,
        [kdUnitBaru, nomorUser]
      );
    }
    if ((!updateResult || updateResult.rowCount === 0) && lidValue) {
      updateResult = await pool.query(
        `UPDATE pengguna SET kd_unit=$1 WHERE whatsapp_lid=$2 RETURNING kd_unit, nama_user`,
        [kdUnitBaru, lidValue]
      );
    }

    // Kalau user belum ada sama sekali di tabel pengguna, buat baru
    if (!updateResult || updateResult.rowCount === 0) {
      const namaFinal = isNamaValid(msg.pushName)
        ? msg.pushName.trim()
        : nomorUser || lidValue;

      if (nomorUser) {
        await pool.query(
          `INSERT INTO pengguna (nama_user, nomor_hp, whatsapp_lid, kd_unit)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (nomor_hp) DO UPDATE
             SET kd_unit = EXCLUDED.kd_unit,
                 whatsapp_lid = COALESCE(EXCLUDED.whatsapp_lid, pengguna.whatsapp_lid)`,
          [namaFinal, nomorUser, lidValue, kdUnitBaru]
        );
      } else if (lidValue) {
        await pool.query(
          `INSERT INTO pengguna (nama_user, nomor_hp, whatsapp_lid, kd_unit)
           VALUES ($1, NULL, $2, $3)
           ON CONFLICT (whatsapp_lid) DO UPDATE
             SET kd_unit = EXCLUDED.kd_unit`,
          [namaFinal, lidValue, kdUnitBaru]
        );
      }
      console.log(`[GANTI UNIT] 🆕 Pengguna baru dibuat sekaligus set kd_unit`);
    }

    const ur = await pool.query(`SELECT nama_unit FROM unit WHERE kd_unit=$1`, [
      kdUnitBaru,
    ]);
    const namaUnitBaru = ur.rows[0]?.nama_unit || namaUnitInput.trim();

    await kirimTeks(
      replyTo,
      `✅ Unit Anda berhasil diubah menjadi *${namaUnitBaru}*.`
    );
    console.log(
      `[GANTI UNIT] ✅ ${nomorUser || lidValue} → kd_unit=${kdUnitBaru} (${namaUnitBaru})`
    );
  } catch (e) {
    console.error("[GANTI UNIT] Error:", e.message);
    await kirimTeks(replyTo, `❌ Gagal mengganti unit: ${e.message}`);
  }
}

// ================================================================
// Buffer lampiran untuk #done — mirip albumBuffer punya #laporsimrs,
// supaya kalau admin kirim BEBERAPA foto sekaligus (album) sebagai
// bukti penyelesaian dengan caption #doneXX, semuanya tertampung dulu
// sebelum handleDone() dipanggil sekali dengan semua file.
// ================================================================
const doneBuffer = new Map();

function doneBufferKey(msg, senderJid) {
  const groupedId =
    msg.message?.imageMessage?.contextInfo?.groupedId ||
    msg.message?.videoMessage?.contextInfo?.groupedId;
  const tsBucket = Math.floor((msg.messageTimestamp || Date.now() / 1000) / 10);
  if (groupedId) return `${senderJid}_donealbum_${groupedId}`;
  return `${senderJid}_donealbum_${tsBucket}`;
}

// Dipanggil dari messages.upsert saat #doneXX terdeteksi. Kalau pesannya
// membawa media, tunggu sebentar (buffer) untuk menampung sisa foto album
// sebelum benar-benar memproses #done. Kalau tidak ada media sama sekali,
// langsung proses seperti biasa (tanpa lampiran).
async function triggerDone(msg, idPesan, pesanSolusi, senderJid) {
  const msgType = Object.keys(msg.message || {})[0];
  const isMediaMsg = [
    "imageMessage",
    "videoMessage",
    "documentMessage",
    "audioMessage",
  ].includes(msgType);

  if (!isMediaMsg) {
    await handleDone(msg, idPesan, pesanSolusi, senderJid, []);
    return;
  }

  const key = doneBufferKey(msg, senderJid);
  let buf = doneBuffer.get(key);
  if (!buf) {
    buf = { files: [], timer: null, idPesan, pesanSolusi, senderJid, msg };
    doneBuffer.set(key, buf);
  }
  if (pesanSolusi) buf.pesanSolusi = pesanSolusi;

  const file = await simpanMedia(msg, msg.key.id + "_" + Date.now()).catch(
    (e) => {
      console.error("[DONE MEDIA]", e.message);
      return null;
    }
  );
  if (file) {
    buf.files.push(file);
    console.log(`[DONE MEDIA] total lampiran: ${buf.files.length}`);
  }

  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => finalisasiDone(key), 3500);
  doneBuffer.set(key, buf);
}

async function finalisasiDone(key) {
  const buf = doneBuffer.get(key);
  if (!buf) return;
  doneBuffer.delete(key);
  await handleDone(
    buf.msg,
    buf.idPesan,
    buf.pesanSolusi,
    buf.senderJid,
    buf.files
  );
}

// ================================================================
// Handler: #lapor — masukkan ke buffer (grouping album foto)
// ================================================================
async function handleLaporBuffer(msg, combined, senderJid, fromJid) {
  for (const [k, v] of albumBuffer.entries()) {
    if (k.startsWith(senderJid + "_") && v.waitingTrigger && !v.processed) {
      console.log(
        `[ORPHAN] ✅ Trigger datang, gabung ke buffer: ${k} (${v.files.length} file tertampung)`
      );
      if (v.timer) clearTimeout(v.timer);
      v.waitingTrigger = false;
      v.messages.push(msg);
      if (combined && combined.length > (v.combined || "").length)
        v.combined = combined;

      v.timer = setTimeout(() => prosesLaporan(k), 15000);
      albumBuffer.set(k, v);
      return;
    }
  }

  const msgType = Object.keys(msg.message || {})[0];
  const isMediaMsg = [
    "imageMessage",
    "videoMessage",
    "documentMessage",
    "audioMessage",
  ].includes(msgType);
  const groupedId =
    msg.message?.imageMessage?.contextInfo?.groupedId ||
    msg.message?.videoMessage?.contextInfo?.groupedId;
  const tsBucket = Math.floor((msg.messageTimestamp || Date.now() / 1000) / 10);

  let senderKey;
  if (groupedId) senderKey = `${senderJid}_album_${groupedId}`;
  else if (isMediaMsg) senderKey = `${senderJid}_media_${tsBucket}`;
  else senderKey = `${senderJid}_text_${msg.key.id}`;

  let buf = albumBuffer.get(senderKey);
  if (!buf) {
    buf = {
      files: [],
      messages: [],
      timer: null,
      processed: false,
      combined,
      fromJid,
    };
    albumBuffer.set(senderKey, buf);
  }
  buf.messages.push(msg);
  if (combined && combined.length > (buf.combined || "").length)
    buf.combined = combined;

  if (isMediaMsg) {
    const file = await simpanMedia(msg, msg.key.id + "_" + Date.now()).catch(
      (e) => {
        console.error("[DOWNLOAD]", e.message);
        return null;
      }
    );
    if (file) {
      buf.files.push(file);
      console.log("[FILE] total:", buf.files.length);
    }
  }

  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => prosesLaporan(senderKey), 15000);
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
  if (files.length > 3) files.splice(3);

  try {
    const msg = messages[0];
    const fromJid = buf.fromJid || msg.key.remoteJid;

    let nomorUser = null;
    let lidValue = null;

    if (isGroup(fromJid)) {
      const participant =
        typeof (msg.key.participant || "") === "string"
          ? msg.key.participant || ""
          : msg.key.participant?.id || msg.key.participant?.jid || "";

      const participantAlt =
        typeof (msg.key.participantAlt || "") === "string"
          ? msg.key.participantAlt || ""
          : msg.key.participantAlt?.id || msg.key.participantAlt?.jid || "";

      console.log(
        `[NOMOR] participant=${participant} participantAlt=${participantAlt}`
      );

      if (
        participantAlt.endsWith("@s.whatsapp.net") ||
        participantAlt.endsWith("@c.us")
      ) {
        nomorUser = normalizeNomor(participantAlt);
        lidValue = participant.endsWith("@lid") ? participant : null;
        console.log(`[NOMOR] ✅ dari participantAlt: ${nomorUser}`);
      } else if (
        participant.endsWith("@s.whatsapp.net") ||
        participant.endsWith("@c.us")
      ) {
        nomorUser = normalizeNomor(participant);
        console.log(`[NOMOR] ✅ dari participant: ${nomorUser}`);
      } else if (participant.endsWith("@lid")) {
        lidValue = participant;
        console.log(
          `[DEBUG] Mencoba resolve LID: ${lidValue} dari grup: ${fromJid}`
        );

        nomorUser = await resolveNomorDariGrup(sockGlobal, fromJid, lidValue);

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

      if (nomorUser && lidValue) {
        pool
          .query(
            `UPDATE pengguna SET nomor_hp=$1
           WHERE whatsapp_lid=$2 AND (nomor_hp IS NULL OR nomor_hp = '' OR LENGTH(nomor_hp) < 10)`,
            [nomorUser, lidValue]
          )
          .catch(() => {});
      }
    } else if (isLid(fromJid)) {
      lidValue = fromJid;

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
        console.log(`[LID DM] Tidak di DB, coba resolve dari grup...`);
        try {
          const semuaGrup = await sockGlobal.groupFetchAllParticipating();
          for (const grupJid of Object.keys(semuaGrup)) {
            const nomor = await resolveNomorDariGrup(
              sockGlobal,
              grupJid,
              lidValue
            );
            if (nomor) {
              nomorUser = nomor;
              console.log(
                `[LID DM] ✅ Resolve dari grup ${grupJid}: ${nomorUser}`
              );
              await pool
                .query(
                  `UPDATE pengguna SET nomor_hp=$1
                 WHERE whatsapp_lid=$2 AND (nomor_hp IS NULL OR nomor_hp = '' OR LENGTH(nomor_hp) < 10)`,
                  [nomorUser, lidValue]
                )
                .catch(() => {});
              break;
            }
          }
        } catch (e) {
          console.warn(`[LID DM] Gagal resolve dari grup: ${e.message}`);
        }

        if (!nomorUser) {
          console.warn(
            `[LID DM] ❌ Tidak bisa resolve nomor untuk: ${lidValue}`
          );
        }
      }
    } else {
      nomorUser = normalizeNomor(fromJid);
    }

    if (!nomorUser && !lidValue) {
      console.warn("[VALIDASI] Tidak ada nomor maupun LID, skip.");
      return;
    }

    if (!nomorUser && lidValue) {
      nomorUser = null;
      console.warn(
        "[VALIDASI] Nomor tidak tersedia, laporan tetap masuk dengan LID."
      );
    }

    // const namaUser = isNamaValid(msg.pushName)
    //   ? msg.pushName.trim()
    //   : nomorUser || lidValue || "Unknown";
    // Cek dulu apakah nomor/LID ini sudah punya nama VALID tersimpan di
// tabel pengguna (misalnya sudah dikoreksi manual oleh admin). Kalau
// ada, itu yang dipakai — bukan pushName WhatsApp — supaya nama yang
// tersimpan di pesan_masuk.pengirim konsisten dengan data pengguna,
// dan tidak berubah-ubah ikut nama profil WA orang tersebut.
let namaTersimpan = null;
try {
  const cekNama = await pool.query(
    `SELECT nama_user FROM pengguna WHERE nomor_hp = $1 OR whatsapp_lid = $2 LIMIT 1`,
    [nomorUser || null, lidValue || null]
  );
  if (cekNama.rows.length && isNamaValid(cekNama.rows[0].nama_user)) {
    namaTersimpan = cekNama.rows[0].nama_user.trim();
  }
} catch (e) {
  console.warn("[LAPOR] Gagal cek nama tersimpan di pengguna:", e.message);
}

const namaUser =
  namaTersimpan ||
  (isNamaValid(msg.pushName)
    ? msg.pushName.trim()
    : nomorUser || lidValue || "Unknown");

if (namaTersimpan) {
  console.log(
    `[LAPOR] ℹ️ Pakai nama tersimpan di DB: "${namaTersimpan}" (bukan pushName WA: "${msg.pushName || "-"}")`
  );
}

    const semuaText = [];
    for (const m of messages) {
      const b = (
        m.message?.conversation ||
        m.message?.extendedTextMessage?.text ||
        m.message?.imageMessage?.caption ||
        m.message?.videoMessage?.caption ||
        m.message?.documentMessage?.caption ||
        m.message?.audioMessage?.caption ||
        ""
      ).trim();
      if (b) semuaText.push(b);
    }
    const pesanBersih =
      [...new Set(semuaText)]
        .join(" ")
        .replace(/#laporsimrs[,\s]*/gi, "")
        .trim() || "(tanpa isi)";

    const { kdUnit: kdUnitLama } = await upsertPengguna(
      nomorUser,
      namaUser,
      lidValue
    );

    let namaUnitFinal = null;
    if (kdUnitLama) {
      const ur = await pool
        .query(`SELECT nama_unit FROM unit WHERE kd_unit=$1`, [kdUnitLama])
        .catch(() => ({ rows: [] }));
      namaUnitFinal = ur.rows[0]?.nama_unit || null;
    }

    // let kdUnitDeteksi = null;
    // try {
    //   kdUnitDeteksi = await deteksiUnit(pesanBersih);
    // } catch (e) {
    //   console.warn("[UNIT] deteksiUnit error:", e.message);
    // }

    // console.log(
    //   `[UNIT] kdUnitDeteksi=${kdUnitDeteksi}, nomorUser=${nomorUser}, lidValue=${lidValue}`
    // );

    // if (kdUnitDeteksi) {
    //   try {
    //     let updateResult;
    //     if (nomorUser) {
    //       updateResult = await pool.query(
    //         `UPDATE pengguna SET kd_unit=$1 WHERE nomor_hp=$2 RETURNING kd_unit, nama_user`,
    //         [kdUnitDeteksi, nomorUser]
    //       );
    //     } else if (lidValue) {
    //       updateResult = await pool.query(
    //         `UPDATE pengguna SET kd_unit=$1 WHERE whatsapp_lid=$2 RETURNING kd_unit, nama_user`,
    //         [kdUnitDeteksi, lidValue]
    //       );
    //     }

    //     if (updateResult?.rowCount > 0) {
    //       console.log(`[UNIT] ✅ DB updated:`, updateResult.rows[0]);
    //     } else {
    //       console.warn(
    //         `[UNIT] ⚠ Tidak ada row terupdate! nomorUser=${nomorUser} lidValue=${lidValue}`
    //       );
    //       const cekUser = await pool.query(
    //         `SELECT nomor_hp, whatsapp_lid, kd_unit FROM pengguna WHERE nomor_hp=$1 OR whatsapp_lid=$2`,
    //         [nomorUser || null, lidValue || null]
    //       );
    //       console.log(`[UNIT] Data pengguna di DB:`, cekUser.rows);
    //     }

    //     const ur = await pool.query(
    //       `SELECT nama_unit FROM unit WHERE kd_unit=$1`,
    //       [kdUnitDeteksi]
    //     );
    //     namaUnitFinal = ur.rows[0]?.nama_unit || namaUnitFinal;
    //     console.log(`[UNIT] namaUnitFinal: ${namaUnitFinal}`);
    //   } catch (e) {
    //     console.warn("[UNIT] Gagal update:", e.message);
    //   }
    // }

    let kdUnitDeteksi = null;

// ================================================================
// Deteksi unit dari teks laporan HANYA dijalankan kalau user BELUM
// punya kd_unit di tabel pengguna (pertama kali lapor). Kalau sudah
// punya, kd_unit dari tabel pengguna dipakai apa adanya, tidak pernah
// di-override otomatis lagi oleh isi laporan berikutnya.
// Untuk mengubah unit setelahnya, pakai command #gantiunit.
// ================================================================
if (!kdUnitLama) {
  try {
    kdUnitDeteksi = await deteksiUnit(pesanBersih);
  } catch (e) {
    console.warn("[UNIT] deteksiUnit error:", e.message);
  }

  console.log(
    `[UNIT] (lapor pertama, belum ada kd_unit) kdUnitDeteksi=${kdUnitDeteksi}, nomorUser=${nomorUser}, lidValue=${lidValue}`
  );

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
        console.log(`[UNIT] ✅ DB updated (set pertama kali):`, updateResult.rows[0]);
      } else {
        console.warn(
          `[UNIT] ⚠ Tidak ada row terupdate! nomorUser=${nomorUser} lidValue=${lidValue}`
        );
        const cekUser = await pool.query(
          `SELECT nomor_hp, whatsapp_lid, kd_unit FROM pengguna WHERE nomor_hp=$1 OR whatsapp_lid=$2`,
          [nomorUser || null, lidValue || null]
        );
        console.log(`[UNIT] Data pengguna di DB:`, cekUser.rows);
      }

      const ur = await pool.query(
        `SELECT nama_unit FROM unit WHERE kd_unit=$1`,
        [kdUnitDeteksi]
      );
      namaUnitFinal = ur.rows[0]?.nama_unit || namaUnitFinal;
      console.log(`[UNIT] namaUnitFinal: ${namaUnitFinal}`);
    } catch (e) {
      console.warn("[UNIT] Gagal update:", e.message);
    }
  }
} else {
  console.log(
    `[UNIT] ℹ️ User sudah punya kd_unit=${kdUnitLama} (${namaUnitFinal || "-"}), ` +
    `SKIP deteksi ulang dari teks laporan. Gunakan #gantiunit untuk mengubah.`
  );
}

    // const kdDivisi = await deteksiDivisi(pesanBersih);
    // const namaDivisi = await getNamaDivisi(kdDivisi);
    const { kdDivisi, kdMappingDivisi } = await deteksiDivisiMapping(pesanBersih);
    const namaDivisi = await getNamaDivisi(kdDivisi);
    const colWaktu = dbCache.colWaktu || "timestamp";
    const chatIdAsal = fromJid;
    const msgId = msg.key.id;

    const kdUnitFinal = kdUnitDeteksi || kdUnitLama || null;

    // ── Tentukan sumber laporan: nama grup atau "DM" ──────────────
    let sumberLaporan = "DM (Direct Message)";
    if (isGroup(fromJid)) {
      try {
        const metaGrup = await sockGlobal.groupMetadata(fromJid);
        sumberLaporan = metaGrup?.subject || "Grup (nama tidak diketahui)";
      } catch (e) {
        console.warn(`[SUMBER] Gagal ambil nama grup ${fromJid}: ${e.message}`);
        sumberLaporan = "Grup (gagal diambil)";
      }
    }

    console.log(
      `[LAPOR] ${namaUser} | ${nomorUser || "-"} | LID:${
        lidValue || "-"
      } | Unit:${namaUnitFinal || "-"} | File:${
        files.length
      } | "${pesanBersih}"`
    );

        const dbRes = await pool.query(
      `INSERT INTO pesan_masuk (nomor_pengirim,pengirim,isi_pesan,whatsapp_id,${colWaktu},attachments,kd_divisi,kd_mapping_divisi,chat_id,status_hapus,kd_unit_pelapor)
       VALUES ($1,$2,$3,$4,LOCALTIMESTAMP(0),$5,$6,$7,$8,0,$9)
       ON CONFLICT (whatsapp_id) DO NOTHING RETURNING id`,
      [
        nomorUser || lidValue || "unknown",
        namaUser,
        pesanBersih,
        msgId,
        files,
        kdDivisi,
        kdMappingDivisi,
        chatIdAsal,
        kdUnitFinal,
      ]
    );

    if (dbRes.rowCount === 0) {
      console.log("[SKIP] Duplicate:", msgId);
      return;
    }
    const idBaru = dbRes.rows[0].id;

    const notif =
      `🔔 *LAPORAN MASUK* — ID *#${idBaru}*\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `👤 *Nama    :* ${namaUser}\n` +
      (namaUnitFinal ? `🏥 *Ruangan :* ${namaUnitFinal}\n` : "") +
      `📱 *Nomor   :* ${nomorUser || "(LID - belum terdeteksi)"}\n` +
      `🕐 *Pukul   :* ${formatWIB()}\n` +
      `🏷️ *Divisi  :* ${namaDivisi}\n` +
      `📝 *Isi     :*\n${pesanBersih}\n` +
      `📍 *Sumber  :* ${sumberLaporan}\n` +
      (files.length ? `📎 *Lampiran:* ${files.length} file\n` : "") +
      `━━━━━━━━━━━━━━━━━\n` +
      `💬 Balas dengan:\n` +
      `• *#proses${idBaru}* → tandai diproses\n` +
      `• *#done${idBaru}* [solusi] → tandai selesai\n` +
      `• *#up${idBaru}* [alasan] → tandai perlu di-up`;

    try {
      const seenKeys = messages.map((m) => m.key);
      await kirimTeks(GRUP_NOTIF, notif, seenKeys);
      console.log(`[GRUP] ✅ Notif #${idBaru} terkirim`);

      const JEDA_BACA_MIN_MS = 5000;
      const JEDA_BACA_MAX_MS = 12000;
      const jedaBaca = jedaAcak(JEDA_BACA_MIN_MS, JEDA_BACA_MAX_MS);
      console.log(
        `[ACK] ⏳ Jeda baca ${(jedaBaca / 1000).toFixed(
          1
        )}s sebelum auto-reply...`
      );
      await sleep(jedaBaca);

      try {
        let replyTarget = null;
        if (isGroup(fromJid)) {
          replyTarget = fromJid;
        } else if (nomorUser) {
          replyTarget = toJid(nomorUser);
        } else if (lidValue) {
          replyTarget = lidValue;
        }
        if (replyTarget) {
          const pesanAck =
            `✅ Halo *${namaUser}*, laporan Anda telah masuk ke sistem ticketing SIMRS RSUD Karawang.\n\n` +
            `🎫 *ID Tiket :* #${idBaru}\n` +
            (namaUnitFinal ? `🏥 *Unit     :* ${namaUnitFinal}\n` : "") +
            `🕐 *Waktu    :* ${formatWIB()}\n\n` +
            `Tim SIMRS RSUD karawang akan segera menindaklanjuti. Terima kasih! 🙏`;
          await kirimTeks(replyTarget, pesanAck, seenKeys);
          console.log(`[ACK] ✅ Auto-reply terkirim ke ${replyTarget}`);
        } else {
          console.warn(
            `[ACK] ⚠ Tidak ada target valid (nomorUser=${nomorUser}, lidValue=${lidValue})`
          );
        }
      } catch (e) {
        console.warn(`[ACK] ⚠ Gagal kirim auto-reply: ${e.message}`);
      }
    } catch (e) {
      console.error("[GRUP] ❌ Gagal kirim notif:", e.message);
    }

    for (let i = 0; i < files.length; i++) {
      await kirimFile(
        GRUP_NOTIF,
        path.join(__dirname, files[i]),
        `📎 ${i + 1}/${files.length} — #${idBaru}`
      ).catch((e) => console.error("[KIRIM FILE]", e.message));
    }

    console.log(
      `[OK] Laporan #${idBaru} selesai diproses | ${files.length} file`
    );
  } catch (err) {
    console.error("========== ERROR prosesLaporan ==========");
    console.error("msg  :", err.message);
    console.error("stack:", err.stack);
    console.error("=========================================");
  }
}

// ================================================================
// POLLING kirim_wa — fallback retry, sekarang juga lewat antrian
// sehingga tidak menumpuk pengiriman beruntun saat retry massal.
// ================================================================
async function prosesAntrianKirim() {
  if (!sockGlobal) {
    console.log("[POLLING] WA belum ready, skip.");
    return;
  }
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
      else if (raw.endsWith("@c.us"))
        jid = raw.replace("@c.us", "@s.whatsapp.net");
      else if (raw.endsWith("@lid")) jid = raw;
      else jid = toJid(raw);

      try {
        console.log(
          `[POLLING] → ${jid} (id:${row.id_kirim} retry:${row.retry_count})`
        );
        const ok = await kirimTeks(jid, row.isi_pesan);
        if (ok) {
          await pool.query(
            `UPDATE kirim_wa SET status_kirim=1 WHERE id_kirim=$1`,
            [row.id_kirim]
          );
          console.log(`[POLLING] ✅ Terkirim`);
        } else {
          throw new Error("enqueueKirim gagal");
        }
      } catch (sendErr) {
        console.warn(`[POLLING] ⚠ Gagal: ${sendErr.message}`);
        const retry = (row.retry_count || 0) + 1;
        if (retry >= 10) {
          await pool.query(
            `UPDATE kirim_wa SET status_kirim=2 WHERE id_kirim=$1`,
            [row.id_kirim]
          );
          console.error(`[POLLING] ❌ Permanen gagal setelah ${retry}x`);
        } else {
          await pool
            .query(`UPDATE kirim_wa SET retry_count=$1 WHERE id_kirim=$2`, [
              retry,
              row.id_kirim,
            ])
            .catch(() => {});
        }
      }
    }
  } catch (err) {
    if (err.message && !err.message.includes("kirim_wa"))
      console.error("[POLLING]", err.message);
  }
}

// ================================================================
// Auto-update nomor_pengirim di pesan_masuk yang masih berformat LID
// ================================================================
async function syncNomorDariLid() {
  try {
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
        console.log(
          `[SYNC LID] ✅ ID #${row.id}: ${row.nomor_pengirim} → ${nomorBaru}`
        );
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
    cachedGroupMetadata: async (jid) => {
      const hit = groupCache.get(jid);
      if (hit) return hit;
      try {
        const meta = await sock.groupMetadata(jid);
        if (Array.isArray(meta?.participants)) {
          meta.participants = meta.participants
            .map((p) => {
              if (typeof p === "string") return { id: p };
              if (p && typeof p === "object" && !p.id && p.jid)
                return { ...p, id: p.jid };
              return p;
            })
            .filter((p) => p && p.id);
        }
        groupCache.set(jid, meta);
        return meta;
      } catch {
        return undefined;
      }
    },
  });

  sockGlobal = sock;

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

      if (pollingTimer) {
        clearInterval(pollingTimer);
        pollingTimer = null;
      }
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

      await new Promise((r) => setTimeout(r, 3000));
      console.log("[WA] Session warm-up selesai, siap terima pesan.");

      try {
        const groups = await sock.groupFetchAllParticipating();
        console.log("===== GRUP YANG DIIKUTI BOT =====");
        Object.entries(groups).forEach(([id, g]) =>
          console.log(`  ${id} => ${g.subject}`)
        );
        if (!groups[GRUP_NOTIF])
          console.warn(
            `⚠️  Bot TIDAK ADA di grup ${GRUP_NOTIF}! Notif tidak akan terkirim.`
          );
        console.log("=================================");
      } catch (e) {
        console.warn("[WA] Gagal fetch grup:", e.message);
      }

      if (!pollingTimer) {
        pollingTimer = setInterval(prosesAntrianKirim, 5000);
        console.log("[POLLING] Interval dimulai.");
      }

      setInterval(syncNomorDariLid, 30000);
      syncNomorDariLid();

      console.log(
        `[THROTTLE] Mode manusiawi aktif: jeda ${KIRIM_DELAY_MIN_MS}-${KIRIM_DELAY_MAX_MS}ms, max ${MAX_PESAN_PER_MENIT} pesan/menit`
      );
    }
  });

  sock.ev.on("creds.update", saveCreds);

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

  sock.ev.on("messages.upsert", async ({ messages: msgs, type }) => {
    if (type !== "notify") return;

    for (const msg of msgs) {
      if (msg.key.fromMe || !msg.message) continue;

      const fromJid = msg.key.remoteJid;
      if (!fromJid) continue;
      if (fromJid === "status@broadcast") continue;

      catatPendingRead(fromJid, msg.key);

      const msgType = Object.keys(msg.message)[0];

      const bodyRaw = (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        msg.message?.documentMessage?.caption ||
        ""
      ).trim();
      console.log(
        `[RAW MSG] from=${fromJid} participant=${
          msg.key.participant || ""
        } type=${msgType} body="${bodyRaw}"`
      );

      const SKIP_TYPES = [
        "protocolMessage",
        "reactionMessage",
        "pollCreationMessage",
        "pollUpdateMessage",
      ];

      if (msgType === "senderKeyDistributionMessage" && !bodyRaw) {
        console.log(`[SKIP] senderKeyDistributionMessage tanpa body`);
        continue;
      }
      if (SKIP_TYPES.includes(msgType)) continue;

      const rawParticipant =
        msg.key.participant || msg.key.participantAlt || "";
      const participantStr =
        typeof rawParticipant === "string"
          ? rawParticipant
          : rawParticipant?.id || rawParticipant?.jid || "";
      const senderJid = isGroup(fromJid) ? participantStr || fromJid : fromJid;
      const bodyText = (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        msg.message?.documentMessage?.caption ||
        ""
      ).trim();

      console.log(
        `[MSG] From:${senderJid} | Type:${msgType} | Body:"${bodyText}"`
      );
      const lc = bodyText.toLowerCase();

      const matchProses = lc.match(/^#proses(\d+)/);
      if (matchProses) {
        await tandaiSemuaPendingDibaca(fromJid);
        await handleProses(msg, parseInt(matchProses[1]), senderJid);
        continue;
      }

      const matchDone = lc.match(/^#done(\d+)/);
      if (matchDone) {
        await tandaiSemuaPendingDibaca(fromJid);
        const solusi = bodyText.replace(/#done\d+/i, "").trim() || null;
        await triggerDone(msg, parseInt(matchDone[1]), solusi, senderJid);
        continue;
      }

      const matchUp = lc.match(/^#up(\d+)/);
      if (matchUp) {
        await tandaiSemuaPendingDibaca(fromJid);
        const alasan = bodyText.replace(/#up\d+/i, "").trim() || null;
        await handleUp(msg, parseInt(matchUp[1]), alasan, senderJid);
        continue;
      }

      const matchCekOpen = lc.match(/^#cekopen\b/);
      if (matchCekOpen) {
        await tandaiSemuaPendingDibaca(fromJid);
        await handleCekOpen(msg, senderJid, fromJid);
        continue;
      }

    const matchOpenToday = lc.match(/^#opentoday\b/);
if (matchOpenToday) {
  await tandaiSemuaPendingDibaca(fromJid);
  await handleOpenToday(msg, senderJid, fromJid);
  continue;
}

// #openy2026 → laporan belum selesai sepanjang tahun 2026
const matchOpenTahun = lc.match(/^#openy(\d{4})\b/);
if (matchOpenTahun) {
  await tandaiSemuaPendingDibaca(fromJid);
  await handleOpenTahun(msg, senderJid, fromJid, parseInt(matchOpenTahun[1]));
  continue;
}

// #opent1 s/d #opent4 → laporan belum selesai per triwulan (tahun berjalan)
const matchOpenTriwulan = lc.match(/^#opent([1-4])\b/);
if (matchOpenTriwulan) {
  await tandaiSemuaPendingDibaca(fromJid);
  const tahunIni = new Date().getFullYear();
  await handleOpenTriwulan(
    msg,
    senderJid,
    fromJid,
    parseInt(matchOpenTriwulan[1]),
    tahunIni
  );
  continue;
}

// #opens1 / #opens2 → laporan belum selesai per semester (tahun berjalan)
const matchOpenSemester = lc.match(/^#opens([1-2])\b/);
if (matchOpenSemester) {
  await tandaiSemuaPendingDibaca(fromJid);
  const tahunIni = new Date().getFullYear();
  await handleOpenSemester(
    msg,
    senderJid,
    fromJid,
    parseInt(matchOpenSemester[1]),
    tahunIni
  );
  continue;
}

// #open1 s/d #open12 → laporan belum selesai pada bulan tertentu (tahun berjalan)
const matchOpenBulan = lc.match(/^#open(\d{1,2})\b/);
if (matchOpenBulan) {
  await tandaiSemuaPendingDibaca(fromJid);
  const tahunIni = new Date().getFullYear();
  await handleOpenBulan(
    msg,
    senderJid,
    fromJid,
    parseInt(matchOpenBulan[1]),
    tahunIni
  );
  continue;
}

     const matchSumAll = lc.match(/^#sumall\b/);
      if (matchSumAll) {
        await tandaiSemuaPendingDibaca(fromJid);
        await handleSumAll(msg, senderJid, fromJid);
        continue;
      }

      // #sumy2026 → ringkasan 1 tahun penuh
      const matchSumTahun = lc.match(/^#sumy(\d{4})\b/);
      if (matchSumTahun) {
        await tandaiSemuaPendingDibaca(fromJid);
        await handleSumTahun(msg, senderJid, fromJid, parseInt(matchSumTahun[1]));
        continue;
      }

      // #sumt1 s/d #sumt4 → ringkasan triwulan (tahun berjalan)
      const matchSumTriwulan = lc.match(/^#sumt([1-4])\b/);
      if (matchSumTriwulan) {
        await tandaiSemuaPendingDibaca(fromJid);
        const tahunIni = new Date().getFullYear();
        await handleSumTriwulan(
          msg,
          senderJid,
          fromJid,
          parseInt(matchSumTriwulan[1]),
          tahunIni
        );
        continue;
      }

      // #sums1 / #sums2 → ringkasan semester (tahun berjalan)
      const matchSumSemester = lc.match(/^#sums([1-2])\b/);
      if (matchSumSemester) {
        await tandaiSemuaPendingDibaca(fromJid);
        const tahunIni = new Date().getFullYear();
        await handleSumSemester(
          msg,
          senderJid,
          fromJid,
          parseInt(matchSumSemester[1]),
          tahunIni
        );
        continue;
      }

      // #sum1 s/d #sum12 → ringkasan bulan tertentu (tahun berjalan)
      const matchSumBulan = lc.match(/^#sum(\d{1,2})\b/);
      if (matchSumBulan) {
        await tandaiSemuaPendingDibaca(fromJid);
        const tahunIni = new Date().getFullYear();
        await handleSumBulan(
          msg,
          senderJid,
          fromJid,
          parseInt(matchSumBulan[1]),
          tahunIni
        );
        continue;
      }

      const matchSum = lc.match(/^#sum\b/);
      if (matchSum) {
        await tandaiSemuaPendingDibaca(fromJid);
        await handleSum(msg, senderJid, fromJid);
        continue;
      }

      const matchInfo = lc.match(/^#info\b/);
      if (matchInfo) {
        await tandaiSemuaPendingDibaca(fromJid);
        await handleInfo(msg, senderJid, fromJid);
        continue;
      }

      // ================================================================
// Handler INTI: #open untuk PERIODE tertentu (tahun/bulan/triwulan/semester)
// Sama seperti #opentoday, tapi filter tanggalnya berdasarkan rentang
// [tglMulai, tglAkhirExclusive) yang diberikan. Menampilkan laporan
// yang MASIH OPEN/PROSES dan MASUK pada periode tersebut.
// ================================================================
async function handleOpenPeriode(
  msg,
  senderJid,
  fromJid,
  tglMulai,
  tglAkhirExclusive,
  labelPeriode
) {
  console.log(
    `[OPEN PERIODE] "${labelPeriode}" (${tglMulai} s/d <${tglAkhirExclusive}) diminta oleh ${senderJid}`
  );
  const replyTo = fromJid;
  await tandaiDibaca([msg.key]);
  try {
    const colWaktu = dbCache.colWaktu || "timestamp";
    const { rows } = await pool.query(
      `SELECT id, pengirim, isi_pesan, kd_unit_pelapor, status_selesai, ${colWaktu} AS waktu
       FROM pesan_masuk
       WHERE (status_selesai = 0 OR status_selesai = 1)
         AND (status_hapus IS NULL OR status_hapus = 0)
         AND ${colWaktu} >= $1::timestamp
         AND ${colWaktu} < $2::timestamp
       ORDER BY id ASC`,
      [tglMulai, tglAkhirExclusive]
    );

    if (!rows.length) {
      await kirimTeks(
        GRUP_NOTIF,
        `✅ Tidak ada laporan yang belum selesai pada periode *${labelPeriode}*.`
      );
      if (fromJid !== GRUP_NOTIF) {
        await kirimTeks(
          replyTo,
          `✅ Tidak ada laporan yang belum selesai pada periode ${labelPeriode}. Info sudah dikirim ke grup notif.`
        );
      }
      console.log(
        `[OPEN PERIODE] ✅ Tidak ada laporan belum selesai untuk "${labelPeriode}"`
      );
      return;
    }

    const unitRes = await pool
      .query(`SELECT kd_unit, nama_unit FROM unit`)
      .catch(() => ({ rows: [] }));
    const unitMap = {};
    for (const u of unitRes.rows) unitMap[u.kd_unit] = u.nama_unit;

    const chunks = buildDaftarOpenChunks(rows, unitMap);
    const totalBagian = chunks.length;
    const jmlOpen = rows.filter((r) => r.status_selesai === 0).length;
    const jmlProses = rows.filter((r) => r.status_selesai === 1).length;

    for (let i = 0; i < chunks.length; i++) {
      const judul =
        totalBagian > 1
          ? `📋 *DAFTAR LAPORAN BELUM SELESAI — ${labelPeriode}* (🟢${jmlOpen} OPEN 🟡${jmlProses} PROSES) — Bagian ${
              i + 1
            }/${totalBagian}\n━━━━━━━━━━━━━━━━━\n`
          : `📋 *DAFTAR LAPORAN BELUM SELESAI — ${labelPeriode}* (🟢${jmlOpen} OPEN 🟡${jmlProses} PROSES)\n━━━━━━━━━━━━━━━━━\n`;
      const penutup =
        i === chunks.length - 1
          ? `\n━━━━━━━━━━━━━━━━━\nBalas dengan *#proses<ID>* untuk mulai memproses. dan *#done<ID>* untuk menyelesaikan`
          : "";
      await kirimTeks(GRUP_NOTIF, judul + chunks[i] + penutup);
    }

    console.log(
      `[OPEN PERIODE] ✅ ${rows.length} laporan "${labelPeriode}" (🟢${jmlOpen} 🟡${jmlProses}) dikirim ke grup (${totalBagian} bagian)`
    );

    if (fromJid !== GRUP_NOTIF) {
      await kirimTeks(
        replyTo,
        `✅ Daftar laporan yang belum selesai pada periode ${labelPeriode} (${rows.length}) sudah dikirim ke grup notif.`
      );
    }
  } catch (err) {
    console.error("[OPEN PERIODE] Error:", err.message);
    await kirimTeks(
      replyTo,
      `❌ Gagal cek laporan open periode ${labelPeriode}: ${err.message}`
    );
  }
}

// ================================================================
// Wrapper: #openy<tahun> → laporan belum selesai yang masuk dalam
// satu TAHUN penuh. Contoh: #openy2026 → 1 Jan 2026 s/d 31 Des 2026
// ================================================================
async function handleOpenTahun(msg, senderJid, fromJid, tahun) {
  const tglMulai = `${tahun}-01-01`;
  const tglAkhir = `${tahun + 1}-01-01`;
  await handleOpenPeriode(
    msg,
    senderJid,
    fromJid,
    tglMulai,
    tglAkhir,
    `TAHUN ${tahun}`
  );
}

// ================================================================
// Wrapper: #open<bulan> → laporan belum selesai yang masuk dalam
// satu BULAN (tahun berjalan). Contoh: #open11 → November tahun berjalan
// ================================================================
async function handleOpenBulan(msg, senderJid, fromJid, bulan, tahun) {
  if (bulan < 1 || bulan > 12) {
    await kirimTeks(
      fromJid,
      `❌ Bulan tidak valid. Gunakan angka 1-12, contoh: *#open11* untuk November.`
    );
    return;
  }
  const bulanStr = String(bulan).padStart(2, "0");
  const tglMulai = `${tahun}-${bulanStr}-01`;
  const bulanBerikut = bulan === 12 ? 1 : bulan + 1;
  const tahunBerikut = bulan === 12 ? tahun + 1 : tahun;
  const tglAkhir = `${tahunBerikut}-${String(bulanBerikut).padStart(2, "0")}-01`;

  await handleOpenPeriode(
    msg,
    senderJid,
    fromJid,
    tglMulai,
    tglAkhir,
    `BULAN ${NAMA_BULAN_ID[bulan]} ${tahun}`
  );
}

// ================================================================
// Wrapper: #opent<triwulan> → laporan belum selesai pada TRIWULAN
// (tahun berjalan). #opent1=Jan-Mar, #opent2=Apr-Jun, dst.
// ================================================================
async function handleOpenTriwulan(msg, senderJid, fromJid, triwulan, tahun) {
  if (triwulan < 1 || triwulan > 4) {
    await kirimTeks(
      fromJid,
      `❌ Triwulan tidak valid. Gunakan 1-4, contoh: *#opent1* untuk Jan-Mar.`
    );
    return;
  }
  const bulanMulai = (triwulan - 1) * 3 + 1;
  const bulanAkhir = bulanMulai + 3;
  const tahunAkhir = bulanAkhir > 12 ? tahun + 1 : tahun;
  const bulanAkhirNormalisasi = bulanAkhir > 12 ? bulanAkhir - 12 : bulanAkhir;

  const tglMulai = `${tahun}-${String(bulanMulai).padStart(2, "0")}-01`;
  const tglAkhir = `${tahunAkhir}-${String(bulanAkhirNormalisasi).padStart(2, "0")}-01`;

  const namaBulanMulai = NAMA_BULAN_ID[bulanMulai];
  const namaBulanAkhir = NAMA_BULAN_ID[bulanMulai + 2];

  await handleOpenPeriode(
    msg,
    senderJid,
    fromJid,
    tglMulai,
    tglAkhir,
    `TRIWULAN ${triwulan} ${tahun} (${namaBulanMulai}-${namaBulanAkhir})`
  );
}

// ================================================================
// Wrapper: #opens<semester> → laporan belum selesai pada SEMESTER
// (tahun berjalan). #opens1=Jan-Jun, #opens2=Jul-Des.
// ================================================================
async function handleOpenSemester(msg, senderJid, fromJid, semester, tahun) {
  if (semester < 1 || semester > 2) {
    await kirimTeks(
      fromJid,
      `❌ Semester tidak valid. Gunakan 1 atau 2, contoh: *#opens1* untuk Jan-Jun.`
    );
    return;
  }
  const bulanMulai = semester === 1 ? 1 : 7;
  const bulanAkhir = semester === 1 ? 7 : 13;
  const tahunAkhir = bulanAkhir > 12 ? tahun + 1 : tahun;
  const bulanAkhirNormalisasi = bulanAkhir > 12 ? bulanAkhir - 12 : bulanAkhir;

  const tglMulai = `${tahun}-${String(bulanMulai).padStart(2, "0")}-01`;
  const tglAkhir = `${tahunAkhir}-${String(bulanAkhirNormalisasi).padStart(2, "0")}-01`;

  const namaBulanMulai = NAMA_BULAN_ID[bulanMulai];
  const namaBulanAkhir = NAMA_BULAN_ID[bulanMulai + 5];

  await handleOpenPeriode(
    msg,
    senderJid,
    fromJid,
    tglMulai,
    tglAkhir,
    `SEMESTER ${semester} ${tahun} (${namaBulanMulai}-${namaBulanAkhir})`
  );
}

      // #divisiXX dan #unitXX: handler belum diimplementasikan ulang,
      // jadi diabaikan dengan aman (dulu ini nyebabin ReferenceError
      // karena handleGantiDivisi/handleGantiUnit dipanggil padahal
      // fungsinya di-comment).
      const matchDivisi = lc.match(/^#divisi(\d+)/);
      if (matchDivisi) {
        await tandaiSemuaPendingDibaca(fromJid);
        await kirimTeks(
          fromJid,
          `⚠️ Fitur #divisi belum aktif di versi bot ini.`
        );
        continue;
      }

      const matchUnit = lc.match(/^#unit(\d+)/);
      if (matchUnit) {
        await tandaiSemuaPendingDibaca(fromJid);
        await kirimTeks(
          fromJid,
          `⚠️ Fitur #unit belum aktif di versi bot ini.`
        );
        continue;
      }

      const matchDaftar = lc.match(/^#daftar\s+([\d\s\-\+]+)/);
      if (matchDaftar) {
        const nomorInput = normalizeNomor(
          matchDaftar[1].replace(/[\s\-]/g, "")
        );
        if (nomorInput.length < 10) {
          await kirimTeks(
            fromJid,
            `❌ Nomor tidak valid. Contoh: *#daftar 08123456789*`
          );
          continue;
        }

         

        const lidSender = isGroup(fromJid)
          ? msg.key.participant || ""
          : fromJid;

        await pool
          .query(`UPDATE pengguna SET nomor_hp=$1 WHERE whatsapp_lid=$2`, [
            nomorInput,
            lidSender,
          ])
          .catch(() => {});

        await pool
          .query(
            `INSERT INTO pengguna (nama_user, nomor_hp, whatsapp_lid)
           VALUES ($1, $2, $3)
           ON CONFLICT (whatsapp_lid) DO UPDATE SET nomor_hp = EXCLUDED.nomor_hp`,
            [
              isNamaValid(msg.pushName) ? msg.pushName.trim() : nomorInput,
              nomorInput,
              lidSender,
            ]
          )
          .catch(() => {});
        const namaTampilDaftar = isNamaValid(msg.pushName)
          ? msg.pushName.trim()
          : nomorInput;
        await kirimTeks(
          fromJid,
          `✅ Nomor *${nomorInput}* berhasil didaftarkan. Terima kasih, *${namaTampilDaftar}*!`
        );
        console.log(`[DAFTAR] ✅ ${lidSender} → ${nomorInput}`);
        continue;
      }

      const matchGantiUnit = lc.match(/^#gantiunit\s+(.+)/);
      if (matchGantiUnit) {
        await tandaiSemuaPendingDibaca(fromJid);
        // pakai bodyText (bukan lc) supaya nama unit tetap huruf besar/kecil asli
        const namaUnitInput = bodyText.replace(/^#gantiunit\s+/i, "").trim();
        await handleGantiUnit(msg, namaUnitInput, senderJid, fromJid);
        continue;
      }

      const hasLapor = lc.includes("#laporsimrs");
      const isMedia = [
        "imageMessage",
        "videoMessage",
        "documentMessage",
        "audioMessage",
      ].includes(msgType);

      if (!hasLapor && isMedia) {
        // Cek dulu apakah ini bagian dari album lampiran #done yang
        // sedang menunggu (foto susulan tanpa caption #done).
        let activeDoneKey = null;
        for (const [k, v] of doneBuffer.entries()) {
          if (k.startsWith(senderJid + "_donealbum_")) {
            activeDoneKey = k;
            break;
          }
        }
        if (activeDoneKey) {
          const buf = doneBuffer.get(activeDoneKey);
          const file = await simpanMedia(
            msg,
            msg.key.id + "_" + Date.now()
          ).catch(() => null);
          if (file) {
            buf.files.push(file);
            console.log(`[DONE MEDIA] Tambahan → total:${buf.files.length}`);
          }
          if (buf.timer) clearTimeout(buf.timer);
          buf.timer = setTimeout(() => finalisasiDone(activeDoneKey), 3500);
          doneBuffer.set(activeDoneKey, buf);
          continue;
        }

        const tsBucket = Math.floor(
          (msg.messageTimestamp || Date.now() / 1000) / 10
        );
        const keys = [
          `${senderJid}_media_${tsBucket}`,
          `${senderJid}_media_${tsBucket - 1}`,
          `${senderJid}_media_${tsBucket + 1}`,
        ];
        let activeKey = keys.find(
          (k) =>
            albumBuffer.has(k) &&
            !albumBuffer.get(k).processed &&
            !albumBuffer.get(k).waitingTrigger
        );
        if (!activeKey) {
          for (const [k, v] of albumBuffer.entries()) {
            if (
              k.startsWith(senderJid + "_") &&
              !v.processed &&
              !v.waitingTrigger
            ) {
              activeKey = k;
              break;
            }
          }
        }
        // if (activeKey) {
        //   const buf = albumBuffer.get(activeKey);
        //   buf.messages.push(msg);
        //   const file = await simpanMedia(
        //     msg,
        //     msg.key.id + "_" + Date.now()
        //   ).catch(() => null);
        //   if (file) {
        //     buf.files.push(file);
        //     console.log(`[FILE] Tambahan → total:${buf.files.length}`);
        //   }
        //   if (buf.timer) clearTimeout(buf.timer);
        //   buf.timer = setTimeout(() => prosesLaporan(activeKey), 5000);
        //   albumBuffer.set(activeKey, buf);
        //   continue;
        // }

        // console.log(
        //   "[MSG] Bukan #laporsimrs & tidak ada buffer aktif, diabaikan."
        // );
        // continue;

        if (activeKey) {
          const buf = albumBuffer.get(activeKey);
          buf.messages.push(msg);
          const file = await simpanMedia(
            msg,
            msg.key.id + "_" + Date.now()
          ).catch(() => null);
          if (file) {
            buf.files.push(file);
            console.log(`[FILE] Tambahan → total:${buf.files.length}`);
          }
          if (buf.timer) clearTimeout(buf.timer);
          buf.timer = setTimeout(() => prosesLaporan(activeKey), 5000);
          albumBuffer.set(activeKey, buf);
          continue;
        }

        let orphanActiveKey = null;
        for (const [k, v] of albumBuffer.entries()) {
          if (
            k.startsWith(senderJid + "_") &&
            v.waitingTrigger &&
            !v.processed
          ) {
            orphanActiveKey = k;
            break;
          }
        }
        if (orphanActiveKey) {
          const buf = albumBuffer.get(orphanActiveKey);
          buf.messages.push(msg);
          const file = await simpanMedia(
            msg,
            msg.key.id + "_" + Date.now()
          ).catch(() => null);
          if (file) {
            buf.files.push(file);
            console.log(
              `[ORPHAN] 📥 Foto susulan ditambahkan → total:${buf.files.length}`
            );
          }
          if (buf.timer) clearTimeout(buf.timer);
          buf.timer = setTimeout(() => {
            const b = albumBuffer.get(orphanActiveKey);
            if (b && b.waitingTrigger && !b.processed) {
              console.warn(
                `[ORPHAN] ❌ Trigger #laporsimrs tidak datang, buffer dibuang (${b.files.length} file hilang) untuk ${senderJid}`
              );
              albumBuffer.delete(orphanActiveKey);
            }
          }, LAPOR_ORPHAN_GRACE_MS);
          albumBuffer.set(orphanActiveKey, buf);
          continue;
        }

        const orphanKey = `${senderJid}_media_${tsBucket}`;
        const orphanBuf = {
          files: [],
          messages: [msg],
          timer: null,
          processed: false,
          combined: "",
          fromJid,
          waitingTrigger: true,
        };
        albumBuffer.set(orphanKey, orphanBuf);
        orphanBuf.timer = setTimeout(() => {
          const b = albumBuffer.get(orphanKey);
          if (b && b.waitingTrigger && !b.processed) {
            console.warn(
              `[ORPHAN] ❌ Trigger #laporsimrs tidak datang, buffer dibuang (${b.files.length} file hilang) untuk ${senderJid}`
            );
            albumBuffer.delete(orphanKey);
          }
        }, LAPOR_ORPHAN_GRACE_MS);
        console.log(
          `[ORPHAN] 🕓 Buffer didaftarkan (menunggu download + trigger): ${orphanKey}`
        );

        // Download dilakukan SETELAH buffer terdaftar. File yang selesai
        // di-download akan otomatis nyangkut ke buffer yang sama (referensi objek orphanBuf), meski trigger sudah meng-klaim buffer ini duluan.
        const orphanFile = await simpanMedia(
          msg,
          msg.key.id + "_" + Date.now()
        ).catch((e) => {
          console.error("[ORPHAN] Gagal download media:", e.message);
          return null;
        });
        if (orphanFile && !orphanBuf.processed) {
          orphanBuf.files.push(orphanFile);
          console.log(
            `[ORPHAN] 📥 File selesai di-download & ditambahkan: total ${orphanBuf.files.length}`
          );
        }
        continue;
      }

      if (!hasLapor) {
        console.log("[MSG] Bukan #laporsimrs, diabaikan.");
        continue;
      }
      await tandaiSemuaPendingDibaca(fromJid);
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
      `SELECT pengirim, nomor_pengirim, chat_id FROM pesan_masuk WHERE id=$1`,
      [id]
    );
    if (!rows.length)
      return res
        .status(404)
        .json({ success: false, error: "Laporan tidak ditemukan" });

    const lap = rows[0];
    const tujuan = await getTujuan(id);
    if (!tujuan)
      return res
        .status(400)
        .json({ success: false, error: "Nomor tujuan tidak ditemukan" });

    if (status === 1) {
      const kdUser = await ambilAtauBuatKdUser(
        lap.nomor_pengirim,
        lap.pengirim
      );

      await pool.query(
        `UPDATE pesan_masuk SET status_selesai=1, tgl_proses=LOCALTIMESTAMP(0), kd_user_proses=$1 WHERE id=$2`,
        [kdUser, id]
      );
      // const pesan = `Halo *${lap.pengirim}*, laporan Anda *sedang kami proses*. Kami akan segera menindaklanjuti. 🔧`;

      const berhasil = await kirimLangsungKeUser(tujuan, pesan);
      await antrikanKirim({
        nomor_pengirim: tujuan,
        kd_user: kdUser,
        isi_pesan: pesan,
        id_pesan_masuk: id,
        status_kirim: berhasil ? 1 : 0,
      });

      // await kirimTeks(
      //   GRUP_NOTIF,
      //   `🔄 *UPDATE* — Laporan *#${id}*\n👤 ${lap.pengirim}\n→ Status: *DIPROSES* oleh *${namaOperator}* (Dashboard)`
      // ).catch((e) => console.warn("[GRUP]", e.message));
    } else if (status === 2) {
      const kdUser = await ambilAtauBuatKdUser(
        lap.nomor_pengirim,
        lap.pengirim
      );

      await pool.query(
        `UPDATE pesan_masuk SET status_selesai=2, tgl_selesai=LOCALTIMESTAMP(0), kd_user=$1 WHERE id=$2`,
        [kdUser, id]
      );
      const pesan =
        `Halo *${lap.pengirim}*, laporan Anda telah *diselesaikan*. Terima kasih sudah melapor. 🙏` +
        (solusi ? `\n\n📝 *Solusi:* ${solusi}` : "");

      const berhasil = await kirimLangsungKeUser(tujuan, pesan);
      await antrikanKirim({
        nomor_pengirim: tujuan,
        kd_user: kdUser,
        isi_pesan: pesan,
        solusi: solusi || null,
        id_pesan_masuk: id,
        status_kirim: berhasil ? 1 : 0,
      });

      // await kirimTeks(
      //   GRUP_NOTIF,
      //   `✅ *UPDATE* — Laporan *#${id}*\n👤 ${lap.pengirim}\n→ Status: *SELESAI* oleh *${namaOperator}* (Dashboard)` +
      //     (solusi ? `\n📝 Solusi: _${solusi}_` : "")
      // ).catch((e) => console.warn("[GRUP]", e.message));
    } else if (status === 3) {
      const kdUser = await ambilAtauBuatKdUser(
        lap.nomor_pengirim,
        lap.pengirim
      );

      await pool.query(
        `UPDATE pesan_masuk
         SET status_selesai=3, tgl_eskalasi=LOCALTIMESTAMP(0), kd_user_up=$1
         WHERE id=$2`,
        [kdUser, id]
      );

      const pesan =
        `Halo *${lap.pengirim}*, laporan Anda *belum dapat diselesaikan* saat ini dan memerlukan tindak lanjut/konsultasi.` +
        (solusi ? `\n\n📝 *Keterangan:* ${solusi}` : "");

      const berhasil = await kirimLangsungKeUser(tujuan, pesan);
      await antrikanKirim({
        nomor_pengirim: tujuan,
        kd_user: kdUser,
        isi_pesan: pesan,
        solusi: solusi || null,
        id_pesan_masuk: id,
        status_kirim: berhasil ? 1 : 0,
      });

      await kirimTeks(
        GRUP_NOTIF,
        `🔴 *UPDATE* — Laporan *#${id}*\n👤 ${lap.pengirim}\n→ Status: *PERLU ESKALASI* oleh *${namaOperator}* (Dashboard)` +
          (solusi ? `\n📝 Keterangan: _${solusi}_` : "")
      ).catch((e) => console.warn("[GRUP]", e.message));
    }

    res.json({ success: true });
  } catch (err) {
    console.error("[API] update-status:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ================================================================
// API: Kirim PDF ke WA — lewat antrian juga
// ================================================================
app.post("/send-pdf", upload.single("pdf"), async (req, res) => {
  const { nomor, caption } = req.body;
  if (!nomor || !req.file)
    return res
      .status(400)
      .json({ success: false, error: "nomor dan pdf wajib ada" });
  try {
    const raw = String(nomor).trim();
    const jid = raw.includes("@")
      ? raw.replace("@c.us", "@s.whatsapp.net")
      : toJid(raw);
    const name = `report_${Date.now()}.pdf`;
    const fp = path.join(UPLOAD_DIR, name);
    fs.writeFileSync(fp, req.file.buffer);

    const ok = await enqueueKirim({
      tipe: "dokumen",
      jid,
      buf: req.file.buffer,
      caption: caption || "Laporan Helpdesk IT",
      fileName: name,
    });

    setTimeout(() => {
      try {
        fs.unlinkSync(fp);
      } catch {}
    }, 60000);
    console.log(`[SEND-PDF] ${ok ? "✅" : "⚠"} → ${jid}`);
    res.json({ success: ok });
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
  if (!isi_pesan)
    return res
      .status(400)
      .json({ success: false, error: "isi_pesan wajib diisi" });
  try {
    const colWaktu = dbCache.colWaktu || "timestamp";
    const nomorFinal = nomor ? normalizeNomor(nomor) : "0";
    const pesanBersih = String(isi_pesan)
      .replace(/#lapor/gi, "")
      .trim();
    const whatsappId = `manual_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const kdDivisiVal = kd_divisi
      ? parseInt(kd_divisi)
      : await deteksiDivisi(pesanBersih);

    let kdUnitVal = null;
    if (nomorFinal !== "0") {
      const { kdUnit } = await upsertPengguna(
        nomorFinal,
        nama || "Admin Input",
        null
      );
      kdUnitVal = kdUnit || null;
    }
    if (unit && unit.trim()) {
      const kdUnitDariTeks = await deteksiUnit(unit.trim());
      if (kdUnitDariTeks) kdUnitVal = kdUnitDariTeks;
    }

    const savedFiles = [];
    for (const f of req.files || []) {
      const ext = path.extname(f.originalname) || "";
      const name = `manual_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 6)}${ext}`;
      fs.writeFileSync(path.join(UPLOAD_DIR, name), f.buffer);
      savedFiles.push(`upload/${name}`);
    }

    const dbRes = await pool.query(
      `INSERT INTO pesan_masuk (nomor_pengirim,pengirim,isi_pesan,whatsapp_id,${colWaktu},attachments,kd_divisi,chat_id,kd_unit)
       VALUES ($1,$2,$3,$4,LOCALTIMESTAMP(0),$5,$6,$7,$8) RETURNING id`,
      [
        nomorFinal,
        nama || "Admin Input",
        pesanBersih,
        whatsappId,
        savedFiles,
        kdDivisiVal,
        nomorFinal + "@s.whatsapp.net",
        kdUnitVal,
      ]
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

    await kirimTeks(GRUP_NOTIF, notif).catch((e) =>
      console.warn("[GRUP] manual:", e.message)
    );
    for (let i = 0; i < savedFiles.length; i++) {
      await kirimFile(
        GRUP_NOTIF,
        path.join(__dirname, savedFiles[i]),
        `📎 ${i + 1}/${savedFiles.length} — #${idBaru}`
      ).catch((e) =>
        console.warn(`[MANUAL] Gagal lampiran ${i + 1}:`, e.message)
      );
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
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/update-divisi", async (req, res) => {
  const { id, kd_divisi } = req.body;
  if (!id) return res.status(400).json({ success: false, error: "id wajib" });
  try {
    await pool.query(`UPDATE pesan_masuk SET kd_divisi=$1 WHERE id=$2`, [
      kd_divisi || null,
      id,
    ]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/list-groups", async (req, res) => {
  if (!sockGlobal) return res.status(503).json({ error: "WA belum ready" });
  try {
    const g = await sockGlobal.groupFetchAllParticipating();
    res.json(Object.entries(g).map(([id, m]) => ({ id, name: m.subject })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/debug-antrian", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id_kirim,nomor_pengirim,isi_pesan,status_kirim,tg_kirim,id_pesan_masuk
       FROM kirim_wa ORDER BY tg_kirim DESC LIMIT 20`
    );
    res.json({ total: rows.length, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/debug-antrian-kirim", (req, res) => {
  res.json({
    panjang_antrian: antrianKirimQueue.length,
    sedang_jalan: antrianSedangJalan,
    pesan_1_menit_terakhir: jejakWaktuKirim.length,
    batas_per_menit: MAX_PESAN_PER_MENIT,
    jeda_ms: { min: KIRIM_DELAY_MIN_MS, max: KIRIM_DELAY_MAX_MS },
  });
});

app.get("/debug-grup-participants", async (req, res) => {
  if (!sockGlobal) return res.status(503).json({ error: "WA belum ready" });
  try {
    const meta = await sockGlobal.groupMetadata(GRUP_NOTIF);
    const sample = (meta.participants || []).slice(0, 5).map((p) => ({
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
    const r = await pool.query(
      `UPDATE kirim_wa SET status_kirim=0,retry_count=0 WHERE status_kirim=2 RETURNING id_kirim`
    );
    res.json({ success: true, direset: r.rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/ping-wa", (req, res) => {
  res.json({
    connected: sockGlobal?.ws?.readyState === 1,
    user: sockGlobal?.user || null,
  });
});

app.get("/test-group", async (req, res) => {
  if (!sockGlobal) return res.status(503).json({ error: "WA belum ready" });
  try {
    await kirimTeks(GRUP_NOTIF, "TEST GROUP dari API");
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post("/logout", async (req, res) => {
  try {
    if (sockGlobal) await sockGlobal.logout().catch(() => {});
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    res.json({
      success: true,
      message: "Session dihapus. Restart untuk scan QR baru.",
    });
    setTimeout(() => process.exit(0), 1000);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

app.get("/sync-nomor-dari-grup", async (req, res) => {
  if (!sockGlobal) return res.status(503).json({ error: "WA belum ready" });
  try {
    const meta = await sockGlobal.groupMetadata(GRUP_NOTIF);
    const participants = meta.participants || [];

    let updated = 0;
    const hasil = [];

    for (const p of participants) {
      const lid = p.id || "";
      const phone = p.phoneNumber || "";
      if (!lid.endsWith("@lid") || !phone) continue;

      const nomor = normalizeNomor(phone);
      if (!nomor || nomor.length < 10) continue;

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

    res.json({
      success: true,
      total_participant: participants.length,
      updated,
      hasil,
    });
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

    const dbRows = await pool.query(
      `SELECT nama_user, nomor_hp, whatsapp_lid FROM pengguna`
    );

    const grupLids = participants
      .filter((p) => (p.id || "").endsWith("@lid") && p.phoneNumber)
      .map((p) => ({
        lid: p.id,
        phone: p.phoneNumber,
        nomor: normalizeNomor(p.phoneNumber),
      }));

    const dbLids = dbRows.rows.map((r) => ({
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

// ================================================================
// Static files & start
// ================================================================
app.use("/upload", express.static(UPLOAD_DIR));
app.listen(8000, "0.0.0.0", () => console.log("[API] Server port 8000"));

startSock().catch((err) => {
  console.error("[FATAL]", err.message);
  process.exit(1);
});

import { google } from "googleapis";

const SPREADSHEET_ID = "1_qNDrGBfqU1D3aWHhVtPlEKP3lKLH_SCdesYM3iZ1ok"; //laporan2026 helpdesk
const SHEET_NAME_DEFAULT = "default"; // nama tab sheet


// Validasi nama tab: Google Sheets melarang karakter [ ] * ? / \ : dan
// nama kosong / lebih dari 100 karakter.
function isNamaSheetValid(nama) {
  if (!nama || typeof nama !== "string") return false;
  const bersih = nama.trim();
  if (!bersih || bersih.length > 100) return false;
  if (/[\[\]\*\?\/\\:]/.test(bersih)) return false;
  return true;
}

// Pastikan tab dengan nama tsb ada. Kalau belum ada, buat baru otomatis
// supaya frontend bisa isi nama bebas tanpa perlu bikin tab manual dulu.
async function pastikanSheetAda(sheets, spreadsheetId, sheetName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const ada = (meta.data.sheets || []).some(
    (s) => s.properties?.title === sheetName
  );
  if (ada) return false; // sudah ada

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: sheetName } } }],
    },
  });
  console.log(`[SHEETS] 🆕 Tab baru dibuat: "${sheetName}"`);
  return true; // baru dibuat
}

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, "service-account.json"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const client = await auth.getClient();
  return google.sheets({ version: "v4", auth: client });
}

// app.post("/kirim-spreadsheet", async (req, res) => {
//   try {
//     const { data } = req.body; // array laporan dari frontend
//     if (!Array.isArray(data) || !data.length) {
//       return res.status(400).json({ success: false, error: "Data kosong" });
//     }

//     const statusLabel = { 0: "Open", 1: "On Progress", 2: "Selesai", 3: "Perlu TL" };
//     const rows = data.map((d) => [
//       d.id, d.unit || "-", d.nama_user || d.pengirim || "-",
//       d.waktu || "-", d.tgl_proses || "-", d.tgl_selesai || "-",
//       d.nama_divisi || "-", d.isi_pesan || "-", d.solusi || "-",
//       d.petugas || "-", statusLabel[parseInt(d.status_selesai)] || "Open",
//     ]);

//     const sheets = await getSheetsClient();

//     // (opsional) bersihkan dulu isi lama sebelum tulis ulang
//     await sheets.spreadsheets.values.clear({
//       spreadsheetId: SPREADSHEET_ID,
//       range: `${SHEET_NAME}!A2`,
//     });

// await sheets.spreadsheets.values.update({
//       spreadsheetId: SPREADSHEET_ID,
//       range: `${SHEET_NAME}!A1`,
//       valueInputOption: "USER_ENTERED",
//       requestBody: {
//         values: [
//           ["ID","Ruangan","Nama User","Tgl Lapor","Tgl Proses","Tgl Selesai","Divisi","Masalah","Solusi","Petugas","Status"],
//           ...rows,
//         ],
//       },
//     });

//     res.json({ success: true, jumlah: rows.length });
//   } catch (err) {
//     console.error("[SHEETS]", err.message);
//     res.status(500).json({ success: false, error: err.message });
//   }
// });
app.post("/kirim-spreadsheet", async (req, res) => {
  try {
    const { data, sheet_name } = req.body; // array laporan + nama tab (opsional) dari frontend

    if (!Array.isArray(data) || !data.length) {
      return res.status(400).json({ success: false, error: "Data kosong" });
    }

    const namaSheet = sheet_name?.trim() || SHEET_NAME_DEFAULT;
    if (!isNamaSheetValid(namaSheet)) {
      return res.status(400).json({
        success: false,
        error:
          "Nama sheet tidak valid. Tidak boleh kosong, >100 karakter, atau mengandung [ ] * ? / \\ :",
      });
    }

     const statusLabel = { 0: "Open", 1: "On Progress", 2: "Selesai", 3: "Perlu TL" };
    const rows = data.map((d) => [
      d.id, d.unit || "-", d.nama_user || d.pengirim || "-",
      d.waktu || "-", d.tgl_proses || "-", d.tgl_selesai || "-",
      d.nama_divisi || "-", d.isi_pesan || "-", d.solusi || "-",
      d.petugas_dilaporkan || "-", d.petugas_menyelesaikan || "-",
      statusLabel[parseInt(d.status_selesai)] || "Open",
    ]);

    const sheets = await getSheetsClient();
    const sheetBaruDibuat = await pastikanSheetAda(sheets, SPREADSHEET_ID, namaSheet);

    // Kalau tab baru dibuat, tidak ada isi lama untuk dibersihkan
    if (!sheetBaruDibuat) {
      await sheets.spreadsheets.values.clear({
        spreadsheetId: SPREADSHEET_ID,
        range: `${namaSheet}!A2`,
      });
    }

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${namaSheet}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [
          ["ID","Ruangan","Nama User","Tgl Lapor","Tgl Proses","Tgl Selesai","Divisi","Masalah","Solusi","Petugas Dilaporkan","Petugas Menyelesaikan","Status"],
          ...rows,
        ],
      },
    });

    res.json({
      success: true,
      jumlah: rows.length,
      sheet: namaSheet,
      sheet_baru_dibuat: sheetBaruDibuat,
    });
  } catch (err) {
    console.error("[SHEETS]", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});