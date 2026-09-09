<?php
header('Content-Type: application/json');

$host     = "10.100.1.220";
$port     = "5432";
$dbname   = "db_aplikasi";
$user     = "postgres";
$password = "tanyadokterucu";

$dbconn = pg_connect("host=$host port=$port dbname=$dbname user=$user password=$password");
if (!$dbconn) {
    echo json_encode(["error" => "Gagal terhubung ke database"]);
    exit;
}

// ── Handle update-divisi / update-unit via PHP ────────────────────
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $body = json_decode(file_get_contents('php://input'), true);

    if (isset($body['action']) && $body['action'] === 'update_divisi') {
        $id        = (int)($body['id'] ?? 0);
        $kd_divisi = (isset($body['kd_divisi']) && $body['kd_divisi'] !== null && $body['kd_divisi'] !== '')
            ? (int)$body['kd_divisi'] : null;
        if (!$id) {
            echo json_encode(['success' => false, 'error' => 'id kosong']);
            exit;
        }
        $res = $kd_divisi !== null
            ? pg_query_params($dbconn, 'UPDATE pesan_masuk SET kd_divisi = $1 WHERE id = $2', [$kd_divisi, $id])
            : pg_query_params($dbconn, 'UPDATE pesan_masuk SET kd_divisi = NULL WHERE id = $1', [$id]);
        echo json_encode(['success' => (bool)$res, 'error' => $res ? null : pg_last_error($dbconn)]);
        pg_close($dbconn);
        exit;
    }

    if (isset($body['action']) && $body['action'] === 'update_unit') {
        $id      = (int)($body['id'] ?? 0);
        $kd_unit = (isset($body['kd_unit']) && $body['kd_unit'] !== null && $body['kd_unit'] !== '')
            ? (int)$body['kd_unit'] : null;
        if (!$id) {
            echo json_encode(['success' => false, 'error' => 'id kosong']);
            exit;
        }
        $res = $kd_unit !== null
            ? pg_query_params($dbconn, 'UPDATE pesan_masuk SET kd_unit_pelapor = $1 WHERE id = $2', [$kd_unit, $id])
            : pg_query_params($dbconn, 'UPDATE pesan_masuk SET kd_unit_pelapor = NULL WHERE id = $1', [$id]);
        echo json_encode(['success' => (bool)$res, 'error' => $res ? null : pg_last_error($dbconn)]);
        pg_close($dbconn);
        exit;
    }
}

// ── Deteksi nama kolom waktu ──────────────────────────────────────
$colRes = pg_query($dbconn, "
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'pesan_masuk' AND column_name IN ('tgl_lapor','timestamp')
    ORDER BY column_name LIMIT 1
");
$colRow = pg_fetch_assoc($colRes);
$COL    = $colRow ? $colRow['column_name'] : 'tgl_lapor';
$COL_Q  = ($COL === 'timestamp') ? '"timestamp"' : $COL;

// ── Filter dari query string ──────────────────────────────────────
$where  = [];
$params = [];
$pIdx   = 1;

$status = isset($_GET['status']) && $_GET['status'] !== '' ? (int)$_GET['status'] : null;
if ($status !== null) {
    $where[] = "pm.status_selesai = $" . $pIdx++;
    $params[] = $status;
}

$divisi = isset($_GET['divisi']) && $_GET['divisi'] !== '' ? (int)$_GET['divisi'] : null;
if ($divisi !== null) {
    $where[] = "pm.kd_divisi = $" . $pIdx++;
    $params[] = $divisi;
}

$tgl_dari = isset($_GET['tgl_dari']) && $_GET['tgl_dari'] !== '' ? $_GET['tgl_dari'] : null;
if ($tgl_dari !== null) {
    $where[] = "pm.{$COL_Q} >= $" . $pIdx++;
    $params[] = $tgl_dari . ' 00:00:00';
}

$tgl_sampai = isset($_GET['tgl_sampai']) && $_GET['tgl_sampai'] !== '' ? $_GET['tgl_sampai'] : null;
if ($tgl_sampai !== null) {
    $where[] = "pm.{$COL_Q} <= $" . $pIdx++;
    $params[] = $tgl_sampai . ' 23:59:59';
}

$where[] = "(pm.status_hapus IS NULL OR pm.status_hapus = 0)";

$whereClause = count($where) ? 'WHERE ' . implode(' AND ', $where) : '';
// ── Cek kolom solusi di kirim_wa ──────────────────────────────────
$colCekRes      = pg_query($dbconn, "SELECT column_name FROM information_schema.columns
    WHERE table_name = 'kirim_wa' AND column_name = 'solusi'");
$adaKolomSolusi = pg_num_rows($colCekRes) > 0;
$solusiField    = $adaKolomSolusi
    ? "COALESCE(NULLIF(kw.solusi, ''), kw.isi_pesan)"
    : "kw.isi_pesan";

// ── Query utama ───────────────────────────────────────────────────
// Karena bot.js sekarang melakukan upsert ke tabel pengguna
// setiap kali ada laporan masuk, JOIN cukup satu jalur:
// cocokkan 9 digit terakhir nomor_pengirim ke nomor_hp pengguna.
//
// Untuk data lama yang nomor_pengirim-nya berisi ID grup (> 15 digit):
// JOIN tidak akan match → unit/nomor dari pengguna akan NULL,
// lalu fallback ke deteksiRuangan() dari nama WA di PHP.
$query = "
    SELECT
        pm.id,
        TO_CHAR(pm.{$COL_Q},     'DD/MM/YYYY HH24:MI') AS waktu,
        pm.{$COL_Q}   AS raw_tgl_lapor,
        TO_CHAR(pm.tgl_proses,  'DD/MM/YYYY HH24:MI') AS tgl_proses,
        pm.tgl_proses AS raw_tgl_proses,
        TO_CHAR(pm.tgl_selesai, 'DD/MM/YYYY HH24:MI') AS tgl_selesai,

        COALESCE(
            NULLIF(pg_usr.nomor_hp, ''),
            CASE
                WHEN LENGTH(REGEXP_REPLACE(pm.nomor_pengirim,'[^0-9]','','g')) <= 15
                THEN pm.nomor_pengirim
                ELSE NULL
            END
        ) AS nomor_pengirim,

        COALESCE(NULLIF(pg_usr.nama_user, ''), pm.pengirim) AS nama_user,
        pm.pengirim,

        -- Unit: prioritas dari snapshot laporan (kd_unit_pelapor / #unit),
        -- fallback ke unit milik pengguna (kd_unit)
        COALESCE(u_snap.nama_unit, u.nama_unit) AS unit,
        pm.kd_unit_pelapor,

        pm.isi_pesan,
        pm.status_selesai,
        pm.attachments,
        pm.kd_divisi,
        pm.kd_mapping_divisi,
        md.nama_mapping,
        d.name AS nama_divisi,
        pg_petugas.nama_user AS petugas,
        pg_proses.nama_user AS petugas_dilaporkan,
        COALESCE(pg_done.nama_user, pg_up.nama_user) AS petugas_menyelesaikan,
        {$solusiField} AS solusi

    FROM pesan_masuk pm
    LEFT JOIN divisi d ON d.kd_divisi = pm.kd_divisi
    LEFT JOIN mapping_divisi md ON md.kd_mapping_divisi = pm.kd_mapping_divisi

    LEFT JOIN pengguna pg_usr
        ON  LENGTH(REGEXP_REPLACE(pm.nomor_pengirim,'[^0-9]','','g')) <= 15
        AND RIGHT(REGEXP_REPLACE(pg_usr.nomor_hp,   '[^0-9]','','g'), 9)
          = RIGHT(REGEXP_REPLACE(pm.nomor_pengirim, '[^0-9]','','g'), 9)

    LEFT JOIN unit u ON u.kd_unit = pg_usr.kd_unit
    LEFT JOIN unit u_snap ON u_snap.kd_unit = pm.kd_unit_pelapor

      LEFT JOIN LATERAL (
        SELECT kd_user, isi_pesan, solusi
        FROM kirim_wa
        WHERE id_pesan_masuk = pm.id AND status_kirim = 1
        ORDER BY tg_kirim DESC LIMIT 1
    ) kw ON true
    LEFT JOIN pengguna pg_petugas ON pg_petugas.kd_user = kw.kd_user
    LEFT JOIN pengguna pg_proses  ON pg_proses.kd_user  = pm.kd_user_proses
    LEFT JOIN pengguna pg_done    ON pg_done.kd_user    = pm.kd_user_done
    LEFT JOIN pengguna pg_up      ON pg_up.kd_user      = pm.kd_user_up

    $whereClause
    ORDER BY pm.id DESC
    LIMIT 500
";  

if (!$adaKolomSolusi) {
    $query = str_replace(', kw.solusi', '', $query);
    $query = str_replace($solusiField, 'kw.isi_pesan', $query);
}

$result = count($params)
    ? pg_query_params($dbconn, $query, $params)
    : pg_query($dbconn, $query);

if (!$result) {
    echo json_encode(["error" => "Query gagal: " . pg_last_error($dbconn)]);
    exit;
}

// ── Fallback unit dari nama WA (khusus data lama / tidak terdaftar) ──
$unitList = [];
$uRes = pg_query($dbconn, "SELECT column_name FROM information_schema.columns
    WHERE table_name = 'unit' AND column_name = 'nama_unit' LIMIT 1");
if (pg_num_rows($uRes) > 0) {
    $uData = pg_query($dbconn, "SELECT nama_unit FROM unit ORDER BY LENGTH(nama_unit) DESC");
    if ($uData) {
        while ($u = pg_fetch_assoc($uData)) $unitList[] = $u['nama_unit'];
    }
}

function deteksiRuangan($namaPengirim, $unitList)
{
    if (!$namaPengirim || empty($unitList)) return null;
    $lc = mb_strtolower($namaPengirim);
    foreach ($unitList as $unit) {
        if (mb_strpos($lc, mb_strtolower($unit)) !== false) return $unit;
    }
    return null;
}

function parsePgArray($pgArray)
{
    if (!$pgArray || $pgArray === '{}') return [];
    $inner = substr($pgArray, 1, strlen($pgArray) - 2);
    if ($inner === '') return [];
    $result = [];
    $current = '';
    $inQuote = false;
    for ($i = 0, $len = strlen($inner); $i < $len; $i++) {
        $c = $inner[$i];
        if ($c === '"') {
            $inQuote = !$inQuote;
        } elseif ($c === ',' && !$inQuote) {
            if ($current !== '') {
                $result[] = $current;
                $current = '';
            }
        } else {
            $current .= $c;
        }
    }
    if ($current !== '') $result[] = $current;
    return array_values(array_filter($result));
}

// ── Loop hasil ────────────────────────────────────────────────────
$messages = [];
while ($row = pg_fetch_assoc($result)) {
    $row['attachments'] = parsePgArray($row['attachments'] ?? '{}');

    // Unit dari JOIN sudah ada untuk data baru.
    // Fallback substring nama WA untuk data lama (nomor_pengirim = ID grup).
    if (empty($row['unit'])) {
        $row['unit'] = deteksiRuangan($row['pengirim'], $unitList);
    }

    // Hitung durasi lapor → proses
    $row['durasi'] = null;
    if (!empty($row['raw_tgl_lapor']) && !empty($row['raw_tgl_proses'])) {
        $t1 = strtotime($row['raw_tgl_lapor']);
        $t2 = strtotime($row['raw_tgl_proses']);
        if ($t1 && $t2 && $t2 > $t1) {
            $mnt = round(($t2 - $t1) / 60);
            if ($mnt < 60) $row['durasi'] = $mnt . ' menit';
            else {
                $h = floor($mnt / 60);
                $m = $mnt % 60;
                $row['durasi'] = $h . ' jam' . ($m ? ' ' . $m . ' mnt' : '');
            }
        }
    }

    unset($row['raw_tgl_lapor'], $row['raw_tgl_proses']);
    $messages[] = $row;
}

// ── Daftar divisi untuk dropdown ──────────────────────────────────
$divisiList = [];
$dRes = pg_query($dbconn, "SELECT kd_divisi, name FROM divisi ORDER BY kd_divisi");
if ($dRes) {
    while ($d = pg_fetch_assoc($dRes)) $divisiList[] = $d;
}

// ── Daftar unit (kd_unit + nama_unit) untuk modal edit Unit Pelapor ──
$unitOptionList = [];
$uoRes = pg_query($dbconn, "SELECT kd_unit, nama_unit FROM unit ORDER BY nama_unit");
if ($uoRes) {
    while ($uo = pg_fetch_assoc($uoRes)) $unitOptionList[] = $uo;
}

// ── Keywords per divisi (grafik spesifik) ─────────────────────────
if (isset($_GET['action']) && $_GET['action'] === 'keywords') {
    $keywordList = [];
    $kRes = pg_query($dbconn, "
        SELECT
            kd.keyword,
            kd.kd_divisi,
            d.name AS nama_divisi,
            kd.kd_mapping_divisi,
            COALESCE(md.nama_mapping, kd.keyword) AS nama_mapping
        FROM keyword_divisi kd
        LEFT JOIN divisi d ON d.kd_divisi = kd.kd_divisi
        LEFT JOIN mapping_divisi md ON md.kd_mapping_divisi = kd.kd_mapping_divisi
        ORDER BY kd.kd_divisi, md.nama_mapping, kd.keyword
    ");
    if ($kRes) {
        while ($k = pg_fetch_assoc($kRes)) $keywordList[] = $k;
    }
    echo json_encode(['keywords' => $keywordList]);
    pg_close($dbconn);
    exit;
}

// ── Daftar petugas untuk filter ───────────────────────────────────
$petugasList = [];
$pRes = pg_query($dbconn, "
    SELECT DISTINCT pg2.nama_user
    FROM kirim_wa kw
    JOIN pengguna pg2 ON pg2.kd_user = kw.kd_user
    WHERE kw.kd_user IS NOT NULL AND kw.status_kirim = 1
    ORDER BY pg2.nama_user
");
if ($pRes) {
    while ($p = pg_fetch_assoc($pRes)) $petugasList[] = $p['nama_user'];
}
echo json_encode([
    'messages'  => $messages,
    'divisi'    => $divisiList,
    'petugas'   => $petugasList,
    'unit_list' => $unitOptionList,
]);
pg_close($dbconn);