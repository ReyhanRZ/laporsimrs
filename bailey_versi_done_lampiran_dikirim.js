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
 * PERUBAHAN ANTI-DUPLIKAT (Agustus 2026):
 * Masalah: kalau Baileys/WhatsApp me-redeliver event pesan yang sama
 * (reconnect, retry jaringan, dsb), command #proses/#done/#up bisa
 * terpanggil DUA KALI untuk pesan yang SAMA, sehingga notifikasi &
 * lampiran ikut terkirim dobel (mis. 2 foto jadi kekirim 4 kali).
 * Perbaikan:
 * 1. `processedCommandMsgIds` — set global msg.key.id yang sudah
 *    diproses untuk command #proses/#done/#up, supaya event yang sama
 *    yang datang lagi otomatis di-skip SEBELUM handler dipanggil.
 * 2. Guard status di handleDone/handleProses/handleUp — kalau laporan
 *    ternyata statusnya sudah sesuai (mis. sudah "selesai"), handler
 *    berhenti lebih awal tanpa kirim ulang notifikasi/lampiran.
 * 3. `seenMsgIds` per buffer #done — mencegah foto/media yang sama
 *    (msg.key.id sama) didownload & dimasukkan ke lampiran dua kali.
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
// ============  ANTI-DUPLIKAT COMMAND (#proses/#done/#up)  ======
// ================================================================
// Kalau Baileys/WhatsApp mengirim ulang event pesan yang sama (mis.
// karena reconnect atau retry jaringan), command yang sama bisa
// terpanggil dua kali untuk msg.key.id yang identik. Untuk mencegah
// notifikasi & lampiran terkirim dobel, kita simpan jejak msg.key.id
// yang SUDAH diproses, dan skip kalau sudah pernah ada di sini.
const processedCommandMsgIds = new Map(); // msgId -> timestamp diproses
const PROCESSED_MSG_ID_TTL_MS = 10 * 60 * 1000; // 10 menit

function bersihkanProcessedMsgIds() {
  const sekarang = Date.now();
  for (const [id, ts] of processedCommandMsgIds.entries()) {
    if (sekarang - ts > PROCESSED_MSG_ID_TTL_MS) {
      processedCommandMsgIds.delete(id);
    }
  }
}

function sudahDiprosesMsgId(msgId) {
  if (!msgId) return false;
  bersihkanProcessedMsgIds();
  return processedCommandMsgIds.has(msgId);
}

function tandaiMsgIdDiproses(msgId) {
  if (!msgId) return;
  processedCommandMsgIds.set(msgId, Date.now());
}

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

    // Cari dulu via LID
    if (lid) {
      const r = await pool.query(
        `SELECT kd_unit, nomor_hp, whatsapp_lid FROM pengguna WHERE whatsapp_lid=$1 LIMIT 1`,
        [lid]
      );
      if (r.rows.length) {
        row = r.rows[0];
        foundBy = "lid";
      }
    }

    // Jika tidak ketemu via LID, cari via nomor HP
    if (!row && nomorHP) {
      const r = await pool.query(
        `SELECT kd_unit, nomor_hp, whatsapp_lid FROM pengguna WHERE nomor_hp=$1 LIMIT 1`,
        [nomorHP]
      );
      if (r.rows.length) {
        row = r.rows[0];
        foundBy = "nomor";
      }
    }

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

      updates.push(`nama_user=$${idx++}`);
      params.push(namaUser);

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
function cariUnitTerawal(teksWords, keywordRows) {
  const keywordsParsed = keywordRows
    .filter((r) => r.keyword && r.keyword.trim())
    .map((r) => ({
      kd_unit: r.kd_unit,
      keyword: r.keyword.toLowerCase().trim(),
      words: r.keyword.toLowerCase().trim().split(/\s+/).filter(Boolean),
    }));

  for (let i = 0; i < teksWords.length; i++) {
    const kandidat = [];

    for (const kw of keywordsParsed) {
      const n = kw.words.length;
      if (i + n > teksWords.length) continue;

      let cocokSemua = true;
      let exact = true;

      for (let j = 0; j < n; j++) {
        const kataTeks = teksWords[i + j];
        const kataKeyword = kw.words[j];
        if (kataTeks === kataKeyword) continue;
        exact = false;
        const dist = levenshteinDistance(kataTeks, kataKeyword);
        if (dist > toleransiEdit(kataKeyword.length)) {
          cocokSemua = false;
          break;
        }
      }

      if (cocokSemua) {
        kandidat.push({ kd_unit: kw.kd_unit, keyword: kw.keyword, exact });
      }
    }

    if (kandidat.length > 0) {
      // di posisi yang sama: exact match menang lebih dulu,
      // baru kalau semuanya fuzzy, ambil keyword terpanjang (lebih spesifik)
      kandidat.sort((a, b) => {
        if (a.exact !== b.exact) return a.exact ? -1 : 1;
        return b.keyword.length - a.keyword.length;
      });
      const pilihan = kandidat[0];
      console.log(
        `[UNIT] ✅ Match terawal di posisi kata ke-${i}: "${pilihan.keyword}" ` +
          `(${pilihan.exact ? "exact" : "fuzzy"}) → kd_unit=${pilihan.kd_unit}`
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

async function deteksiDivisi(teks) {
  try {
    const { rows } = await pool.query(
      `SELECT kd_divisi, keyword FROM keyword_divisi ORDER BY LENGTH(keyword) DESC`
    );
    const lc = teks.toLowerCase();
    for (const r of rows) {
      if (fuzzyIncludes(lc, r.keyword.toLowerCase())) return r.kd_divisi;
    }
    return null;
  } catch {
    return null;
  }
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
      `SELECT id, pengirim, nomor_pengirim, chat_id, status_selesai FROM pesan_masuk WHERE id=$1`,
      [idPesan]
    );
    if (!rows.length) {
      await kirimTeks(replyTo, `❌ Laporan #${idPesan} tidak ditemukan.`);
      return;
    }

    const lap = rows[0];

    // ANTI-DUPLIKAT: kalau laporan sudah pernah ditandai "diproses"
    // (atau statusnya sudah lebih lanjut, mis. selesai/eskalasi),
    // tidak perlu diproses ulang.
    if (lap.status_selesai && lap.status_selesai >= 1) {
      console.log(
        `[PROSES] ⚠ Laporan #${idPesan} sudah berstatus ${lap.status_selesai}, skip (anti-duplikat).`
      );
      return;
    }

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
      `SELECT id, pengirim, nomor_pengirim, chat_id, status_selesai FROM pesan_masuk WHERE id=$1`,
      [idPesan]
    );
    if (!rows.length) {
      await kirimTeks(replyTo, `❌ Laporan #${idPesan} tidak ditemukan.`);
      return;
    }

    const lap = rows[0];

    // ANTI-DUPLIKAT: kalau laporan #idPesan SUDAH berstatus "selesai"
    // (status_selesai=2) sebelumnya, jangan proses & kirim ulang —
    // ini yang mencegah notifikasi + lampiran dobel saat event pesan
    // #done ter-redeliver oleh WhatsApp/Baileys.
    if (lap.status_selesai === 2) {
      console.log(
        `[DONE] ⚠ Laporan #${idPesan} sudah berstatus SELESAI sebelumnya, skip (anti-duplikat).`
      );
      return;
    }

    const pesanUser =
      `Halo *${lap.pengirim}*, laporan Anda dengan ID ticket *${lap.id}*, telah *diselesaikan*. Terima kasih sudah melapor. 🙏` +
      (attachments.length
        ? `\n\n📎 Bukti penyelesaian terlampir (${attachments.length} file).`
        : "");

    const kdUser = await resolveAdminUntukKdUser(
      senderJid,
      msg.key.remoteJid,
      msg.pushName
    );

    await pool.query(
      `UPDATE pesan_masuk SET status_selesai=2, tgl_selesai=LOCALTIMESTAMP(0), kd_user_done=$1, attachments_done=$2 WHERE id=$3`,
      [kdUser, attachments, idPesan]
    );

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
      for (let i = 0; i < attachments.length; i++) {
        await kirimFile(
          tujuan,
          path.join(__dirname, attachments[i]),
          `📎 Bukti penyelesaian ${i + 1}/${attachments.length} — #${idPesan}`
        ).catch((e) =>
          console.warn(
            `[DONE] Gagal kirim lampiran ke user ${i + 1}:`,
            e.message
          )
        );
      }
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
      `SELECT id, pengirim, nomor_pengirim, chat_id, status_selesai FROM pesan_masuk WHERE id=$1`,
      [idPesan]
    );
    if (!rows.length) {
      await kirimTeks(replyTo, `❌ Laporan #${idPesan} tidak ditemukan.`);
      return;
    }

    const lap = rows[0];

    // ANTI-DUPLIKAT: kalau laporan sudah berstatus "perlu eskalasi",
    // tidak perlu diproses & dikirim ulang.
    if (lap.status_selesai === 3) {
      console.log(
        `[UP] ⚠ Laporan #${idPesan} sudah berstatus ESKALASI sebelumnya, skip (anti-duplikat).`
      );
      return;
    }

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
// Buffer lampiran untuk #done — mirip albumBuffer punya #laporsimrs,
// supaya kalau admin kirim BEBERAPA foto sekaligus (album) sebagai
// bukti penyelesaian dengan caption #doneXX, semuanya tertampung dulu
// sebelum handleDone() dipanggil sekali dengan semua file.
//
// ANTI-DUPLIKAT: setiap buffer punya `seenMsgIds` (Set berisi
// msg.key.id) — dipakai supaya kalau event pesan media yang SAMA
// sampai lagi (redelivery), file-nya TIDAK di-download & dimasukkan
// ke lampiran untuk kedua kalinya.
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
    buf = {
      files: [],
      timer: null,
      idPesan,
      pesanSolusi,
      senderJid,
      msg,
      seenMsgIds: new Set(), // <-- ANTI-DUPLIKAT: jejak msg.key.id yang sudah masuk buffer ini
    };
    doneBuffer.set(key, buf);
  }
  if (pesanSolusi) buf.pesanSolusi = pesanSolusi;

  // ANTI-DUPLIKAT: kalau msg.key.id ini sudah pernah ditampung di buffer
  // yang sama (mis. karena event-nya di-redeliver), jangan download &
  // push filenya lagi.
  if (buf.seenMsgIds.has(msg.key.id)) {
    console.log(
      `[DONE MEDIA] ⏭ msg ${msg.key.id} sudah pernah ditampung di buffer ini, skip duplikat.`
    );
    return;
  }
  buf.seenMsgIds.add(msg.key.id);

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

    const namaUser = isNamaValid(msg.pushName)
      ? msg.pushName.trim()
      : nomorUser || lidValue || "Unknown";

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

    let kdUnitDeteksi = null;
    try {
      kdUnitDeteksi = await deteksiUnit(pesanBersih);
    } catch (e) {
      console.warn("[UNIT] deteksiUnit error:", e.message);
    }

    console.log(
      `[UNIT] kdUnitDeteksi=${kdUnitDeteksi}, nomorUser=${nomorUser}, lidValue=${lidValue}`
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
          console.log(`[UNIT] ✅ DB updated:`, updateResult.rows[0]);
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

    const kdDivisi = await deteksiDivisi(pesanBersih);
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
      `INSERT INTO pesan_masuk (nomor_pengirim,pengirim,isi_pesan,whatsapp_id,${colWaktu},attachments,kd_divisi,chat_id,status_hapus,kd_unit_pelapor)
       VALUES ($1,$2,$3,$4,LOCALTIMESTAMP(0),$5,$6,$7,0,$8)
       ON CONFLICT (whatsapp_id) DO NOTHING RETURNING id`,
      [
        nomorUser || lidValue || "unknown",
        namaUser,
        pesanBersih,
        msgId,
        files,
        kdDivisi,
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
        // ANTI-DUPLIKAT: skip kalau msg.key.id ini sudah pernah diproses
        // sebelumnya (mis. event-nya di-redeliver oleh WhatsApp/Baileys).
        if (sudahDiprosesMsgId(msg.key.id)) {
          console.log(
            `[DEDUP] ⏭ #proses pesan ${msg.key.id} sudah pernah diproses, skip.`
          );
          continue;
        }
        tandaiMsgIdDiproses(msg.key.id);
        await tandaiSemuaPendingDibaca(fromJid);
        await handleProses(msg, parseInt(matchProses[1]), senderJid);
        continue;
      }

      const matchDone = lc.match(/^#done(\d+)/);
      if (matchDone) {
        // ANTI-DUPLIKAT: sama seperti #proses — cegah trigger dobel untuk
        // event pesan #done yang sama, ini akar masalah 2 foto jadi 4x kirim.
        if (sudahDiprosesMsgId(msg.key.id)) {
          console.log(
            `[DEDUP] ⏭ #done pesan ${msg.key.id} sudah pernah diproses, skip.`
          );
          continue;
        }
        tandaiMsgIdDiproses(msg.key.id);
        await tandaiSemuaPendingDibaca(fromJid);
        const solusi = bodyText.replace(/#done\d+/i, "").trim() || null;
        await triggerDone(msg, parseInt(matchDone[1]), solusi, senderJid);
        continue;
      }

      const matchUp = lc.match(/^#up(\d+)/);
      if (matchUp) {
        // ANTI-DUPLIKAT
        if (sudahDiprosesMsgId(msg.key.id)) {
          console.log(
            `[DEDUP] ⏭ #up pesan ${msg.key.id} sudah pernah diproses, skip.`
          );
          continue;
        }
        tandaiMsgIdDiproses(msg.key.id);
        await tandaiSemuaPendingDibaca(fromJid);
        const alasan = bodyText.replace(/#up\d+/i, "").trim() || null;
        await handleUp(msg, parseInt(matchUp[1]), alasan, senderJid);
        continue;
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

          // ANTI-DUPLIKAT: pastikan buffer punya seenMsgIds (jaga-jaga
          // untuk buffer lama) dan skip kalau msg.key.id ini sudah
          // pernah ditampung sebelumnya.
          if (!buf.seenMsgIds) buf.seenMsgIds = new Set();
          if (buf.seenMsgIds.has(msg.key.id)) {
            console.log(
              `[DONE MEDIA] ⏭ msg ${msg.key.id} (susulan) sudah pernah ditampung, skip duplikat.`
            );
            continue;
          }
          buf.seenMsgIds.add(msg.key.id);

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
      const pesan = `Halo *${lap.pengirim}*, laporan Anda *sedang kami proses*. Kami akan segera menindaklanjuti. 🔧`;

      const berhasil = await kirimLangsungKeUser(tujuan, pesan);
      await antrikanKirim({
        nomor_pengirim: tujuan,
        kd_user: kdUser,
        isi_pesan: pesan,
        id_pesan_masuk: id,
        status_kirim: berhasil ? 1 : 0,
      });

      await kirimTeks(
        GRUP_NOTIF,
        `🔄 *UPDATE* — Laporan *#${id}*\n👤 ${lap.pengirim}\n→ Status: *DIPROSES* oleh *${namaOperator}* (Dashboard)`
      ).catch((e) => console.warn("[GRUP]", e.message));
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

      await kirimTeks(
        GRUP_NOTIF,
        `✅ *UPDATE* — Laporan *#${id}*\n👤 ${lap.pengirim}\n→ Status: *SELESAI* oleh *${namaOperator}* (Dashboard)` +
          (solusi ? `\n📝 Solusi: _${solusi}_` : "")
      ).catch((e) => console.warn("[GRUP]", e.message));
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
const SHEET_NAME = "agustus-coba"; // nama tab sheet

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, "service-account.json"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const client = await auth.getClient();
  return google.sheets({ version: "v4", auth: client });
}

app.post("/kirim-spreadsheet", async (req, res) => {
  try {
    const { data } = req.body; // array laporan dari frontend
    if (!Array.isArray(data) || !data.length) {
      return res.status(400).json({ success: false, error: "Data kosong" });
    }

    const statusLabel = { 0: "Open", 1: "On Progress", 2: "Selesai", 3: "Perlu TL" };
    const rows = data.map((d) => [
      d.id, d.unit || "-", d.nama_user || d.pengirim || "-",
      d.waktu || "-", d.tgl_proses || "-", d.tgl_selesai || "-",
      d.nama_divisi || "-", d.isi_pesan || "-", d.solusi || "-",
      d.petugas || "-", statusLabel[parseInt(d.status_selesai)] || "Open",
    ]);

    const sheets = await getSheetsClient();

    // (opsional) bersihkan dulu isi lama sebelum tulis ulang
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A2`,
    });

await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [
          ["ID","Ruangan","Nama User","Tgl Lapor","Tgl Proses","Tgl Selesai","Divisi","Masalah","Solusi","Petugas","Status"],
          ...rows,
        ],
      },
    });

    res.json({ success: true, jumlah: rows.length });
  } catch (err) {
    console.error("[SHEETS]", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});