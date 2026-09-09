<?php
header('Content-Type: application/json');

$input  = json_decode(file_get_contents('php://input'), true);
$id     = intval($input['id'] ?? 0);
$status = intval($input['status'] ?? -1);

if (!$id || $status < 0) {
    echo json_encode(['success'=>false,'error'=>'Parameter tidak lengkap']);
    exit;
}

$host     = "10.100.1.55";
$port     = "5432";
$dbname   = "wa_message";
$user     = "postgres";
$password = "simrs";

$dbconn = pg_connect("host=$host port=$port dbname=$dbname user=$user password=$password");
if (!$dbconn) {
    echo json_encode(['success'=>false,'error'=>'Gagal koneksi DB']);
    exit;
}

if ($status === 1) {
    $q = "UPDATE pesan_masuk SET status_selesai=1, tgl_proses=LOCALTIMESTAMP(0) WHERE id=$1";
    $r = pg_query_params($dbconn, $q, [$id]);
} elseif ($status === 2) {
    $q = "UPDATE pesan_masuk SET status_selesai=2, tgl_selesai=LOCALTIMESTAMP(0) WHERE id=$1";
    $r = pg_query_params($dbconn, $q, [$id]);
} else {
    echo json_encode(['success'=>false,'error'=>'Status tidak valid']);
    exit;
}

if ($r) {
    echo json_encode(['success'=>true]);
} else {
    echo json_encode(['success'=>false,'error'=>pg_last_error($dbconn)]);
}

pg_close($dbconn);