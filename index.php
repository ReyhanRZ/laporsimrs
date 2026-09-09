<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Monitoring Laporan #LAPOR</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"></script>
    <!-- jsPDF untuk download PDF -->
    <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js"></script>
    <style>
    body { background:#f4f7f6; }
    .table-container { margin:28px 0 48px; }
    .badge-number { font-size:.82em; }
    .time-info    { font-size:.78em; }
    #status.online  { color:#28a745; }
    #status.offline { color:#dc3545; }
    #status.loading { color:#17a2b8; }
    tr.row-baru    { border-left:4px solid #ffc107; }
    tr.row-proses  { border-left:4px solid #0d6efd; }
    tr.row-selesai { border-left:4px solid #198754; }
    tr.row-up      { border-left:4px solid #dc3545; background:#fff8f8; } 
    .pagination .page-link { cursor:pointer; }
    .badge-divisi { font-size:.72em; padding:3px 8px; border-radius:20px; white-space:nowrap; }

    .filter-bar {
        background:#fff; border-bottom:1px solid #e0e0e0;
        padding:10px 16px; display:flex; align-items:center; gap:10px; flex-wrap:wrap;
    }
    .filter-bar select,
    .filter-bar input[type="date"] {
        font-size:.82rem; padding:4px 10px;
        border:1px solid #ced4da; border-radius:6px; background:#fff; cursor:pointer;
    }
    .filter-bar select { min-width:165px; }
    .filter-bar label  { font-size:.82rem; color:#555; margin:0; white-space:nowrap; }
    .date-sep          { font-size:.8rem; color:#888; }
    .btn-reset-filter  {
        font-size:.78rem; padding:4px 12px; border-radius:6px;
        border:1px solid #ced4da; background:#f8f9fa; color:#555; cursor:pointer;
    }
    .btn-reset-filter:hover { background:#e9ecef; }

    .btn-lihat {
        display:inline-flex; align-items:center; gap:5px;
        font-size:.8rem; padding:4px 11px; border-radius:20px;
        border:1px solid #0d6efd; color:#0d6efd; background:#fff;
        cursor:pointer; white-space:nowrap; transition:all .18s;
    }
    .btn-lihat:hover { background:#0d6efd; color:#fff; }
    .badge-att { background:#e9ecef; color:#555; border-radius:10px; padding:1px 6px; font-size:.7rem; }

    .btn-divisi {
        display:inline-flex; align-items:center; gap:4px;
        font-size:.72em; padding:3px 9px; border-radius:20px;
        cursor:pointer; border:none; transition:filter .15s, transform .1s;
    }
    .btn-divisi:hover { filter:brightness(1.12); transform:scale(1.04); }
    .btn-divisi-none {
        display:inline-flex; align-items:center; gap:4px;
        font-size:.78rem; padding:3px 9px; border-radius:20px;
        cursor:pointer; border:1px dashed #adb5bd; color:#6c757d;
        background:transparent; white-space:nowrap; transition:all .18s;
    }
    .btn-divisi-none:hover { border-color:#0d6efd; color:#0d6efd; background:#f0f4ff; }

    .btn-unit {
        display:inline-flex; align-items:center; gap:6px;
        font-size:.8rem; padding:2px 4px; border-radius:6px;
        cursor:pointer; border:1px dashed transparent; background:transparent;
        color:#333; transition:all .15s; text-align:left; white-space:normal;
    }
    .btn-unit:hover { border-color:#0d6efd; background:#f0f4ff; color:#0d6efd; }
    .btn-unit .unit-pencil { opacity:.55; font-size:.78em; flex-shrink:0; }
    .btn-unit:hover .unit-pencil { opacity:1; }
    .btn-unit-empty { color:#adb5bd; font-style:italic; }

    .btn-toolbar-action {
        font-size:.8rem; padding:5px 13px; border-radius:6px;
        cursor:pointer; display:inline-flex; align-items:center; gap:5px; transition:all .18s;
    }
    .btn-excel   { border:1px solid #198754; color:#198754; background:#fff; }
    .btn-excel:hover { background:#198754; color:#fff; }
    .btn-pdf-prev { border:1px solid #dc3545; color:#dc3545; background:#fff; }
    .btn-pdf-prev:hover { background:#dc3545; color:#fff; }

    /* Modal Lampiran */
    #lampiranModal .modal-dialog { max-width:940px; }
    #lampiranModal .modal-content { background:#16213e; color:#e0e0e0; border:none; border-radius:12px; overflow:hidden; }
    #lampiranModal .modal-header  { background:#0f3460; border-bottom:1px solid #1a4a80; padding:10px 16px; }
    #lampiranModal .modal-title   { color:#fff; font-size:.95rem; }
    #lampiranModal .btn-close     { filter:invert(1) opacity(.7); }
    .lm-body { display:flex; height:76vh; overflow:hidden; }
    .lm-sidebar { width:190px; flex-shrink:0; background:#0d1b2a; overflow-y:auto; border-right:1px solid #1e3050; padding:6px 0; }
    .lm-file-item { display:flex; align-items:flex-start; gap:8px; padding:9px 10px; cursor:pointer; border-left:3px solid transparent; transition:background .15s; font-size:.78rem; color:#aaa; }
    .lm-file-item:hover  { background:#1a2e45; color:#ddd; }
    .lm-file-item.active { background:#1a3a5c; border-left-color:#4ea8ff; color:#fff; }
    .fi-icon { font-size:1.25rem; flex-shrink:0; margin-top:1px; }
    .fi-name { line-height:1.3; word-break:break-all; }
    .fi-num  { margin-left:auto; flex-shrink:0; background:#1e3050; border-radius:50%; width:18px; height:18px; display:flex; align-items:center; justify-content:center; font-size:.65rem; color:#7ab; }
    .lm-viewer { flex:1; overflow:hidden; display:flex; flex-direction:column; background:#111827; }
    .lm-toolbar { display:flex; align-items:center; gap:6px; padding:6px 12px; background:#0f1f35; border-bottom:1px solid #1e3050; flex-shrink:0; min-height:38px; }
    .lm-filename { font-size:.78rem; color:#aaa; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .tb-btn { background:#1e3050; border:none; color:#ccc; border-radius:6px; padding:3px 9px; font-size:.8rem; cursor:pointer; transition:background .15s; }
    .tb-btn:hover { background:#2a4a70; color:#fff; }
    .tb-btn:disabled { opacity:.35; cursor:default; }
    .zoom-val { font-size:.75rem; color:#7ab; min-width:38px; text-align:center; }
    .pdf-nav  { display:flex; align-items:center; gap:4px; font-size:.78rem; color:#7ab; }
    .lm-view-area { flex:1; overflow:auto; display:flex; align-items:flex-start; justify-content:center; padding:16px; cursor:grab; user-select:none; position:relative; }
    .lm-view-area.grabbing { cursor:grabbing; }
    #imgViewer   { transform-origin:top center; transition:transform .2s; border-radius:6px; display:block; max-width:100%; pointer-events:none; }
    #videoViewer { max-width:100%; max-height:calc(76vh - 80px); border-radius:8px; }
    #pdfWrapper  { display:flex; flex-direction:column; align-items:center; gap:10px; width:100%; }
    #pdfWrapper canvas { border-radius:4px; box-shadow:0 2px 12px rgba(0,0,0,.5); max-width:100%; background:#fff; }
    #fileViewer  { text-align:center; padding:60px 20px; color:#aaa; }
    .fi-dlbtn { margin-top:16px; padding:8px 24px; border-radius:20px; background:#1e3050; color:#7ab; border:1px solid #2a4a70; text-decoration:none; font-size:.85rem; display:inline-block; }
    .fi-dlbtn:hover { background:#2a4a70; color:#fff; }
    .lm-loading { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; background:rgba(17,24,39,.75); z-index:10; font-size:.9rem; color:#7ab; gap:10px; }
    .spinner { width:20px; height:20px; border:2px solid #2a4a70; border-top-color:#4ea8ff; border-radius:50%; animation:spin .7s linear infinite; }
    @keyframes spin { to { transform:rotate(360deg); } }

    /* Modal Divisi */
    #divisiModal .modal-dialog { max-width:460px; }
    .divisi-option, .divisi-option-none {
        display:flex; align-items:center; gap:10px;
        padding:9px 14px; border-radius:8px; cursor:pointer;
        border:2px solid transparent; transition:all .15s;
        margin-bottom:6px; background:#f8f9fa;
    }
    .divisi-option:hover       { border-color:#0d6efd; background:#f0f4ff; }
    .divisi-option.selected    { border-color:#0d6efd; background:#e8f0fe; }
    .divisi-option-none        { border:2px dashed #dee2e6; color:#6c757d; background:#fff; }
    .divisi-option-none:hover  { border-color:#dc3545; color:#dc3545; background:#fff5f5; }
    .divisi-option-none.selected { border-color:#dc3545; color:#dc3545; background:#fff5f5; }
    .divisi-dot  { width:10px; height:10px; border-radius:50%; flex-shrink:0; }
    .divisi-name { font-weight:500; font-size:.88rem; }
    .divisi-kd   { font-size:.75rem; color:#888; margin-left:auto; }

    /* Modal Unit */
    #unitModal .modal-dialog { max-width:460px; }
    #unitModal .modal-body { max-height:60vh; overflow-y:auto; }
    .unit-option, .unit-option-none {
        display:flex; align-items:center; gap:10px;
        padding:9px 14px; border-radius:8px; cursor:pointer;
        border:2px solid transparent; transition:all .15s;
        margin-bottom:6px; background:#f8f9fa;
    }
    .unit-option:hover       { border-color:#0d6efd; background:#f0f4ff; }
    .unit-option.selected    { border-color:#0d6efd; background:#e8f0fe; }
    .unit-option-none        { border:2px dashed #dee2e6; color:#6c757d; background:#fff; }
    .unit-option-none:hover  { border-color:#dc3545; color:#dc3545; background:#fff5f5; }
    .unit-option-none.selected { border-color:#dc3545; color:#dc3545; background:#fff5f5; }
    .unit-name { font-weight:500; font-size:.88rem; }
    #unitSearchBox { font-size:.85rem; padding:6px 10px; border:1px solid #ced4da; border-radius:8px; width:100%; margin-bottom:10px; }

    /* Modal Preview/Print PDF */
    #pdfPrintModal .modal-dialog { max-width:960px; }
    #pdfPrintModal .modal-content { border-radius:10px; overflow:hidden; }
    #pdfPrintModal .modal-header { background:#1a3a5c; color:#fff; padding:10px 16px; border:none; }
    #pdfPrintModal .modal-title  { font-size:.95rem; color:#fff; }
    #pdfPrintModal .btn-close    { filter:invert(1) opacity(.8); }
    .pdf-print-toolbar {
        display:flex; align-items:center; gap:8px;
        padding:8px 16px; background:#f8f9fa; border-bottom:1px solid #dee2e6;
    }

    /* Area preview laporan */
    #laporanPreviewWrap {
        background:#d0d0d0; padding:16px; overflow-y:auto; max-height:78vh;
    }

    /* ── HALAMAN CETAK — KUNCI RAPIH ── */
    .laporan-page {
        background:#fff;
        width: 267mm;           /* A4 landscape lebar efektif */
        margin: 0 auto 16px;
        padding: 10mm 10mm 14mm;
        font-family: Arial, Helvetica, sans-serif;
        font-size: 8.5pt;
        box-shadow: 0 2px 10px rgba(0,0,0,.18);
        box-sizing: border-box;
        /* Jangan gunakan page-break di sini — diatur di @media print */
    }
    .laporan-page .kop {
        text-align:center; margin-bottom:6px; border-bottom:2px solid #1a3a5c; padding-bottom:5px;
    }
    .laporan-page .kop h2 { font-size:11pt; margin:0 0 1px; color:#1a3a5c; text-transform:uppercase; letter-spacing:.4px; }
    .laporan-page .kop p  { font-size:8pt; margin:0; color:#555; }
    .laporan-page .meta-row { display:flex; justify-content:space-between; font-size:7.5pt; color:#666; margin-bottom:5px; }

    .laporan-page table { width:100%; border-collapse:collapse; margin-bottom:8px; }
    .laporan-page thead th {
        background:#1a3a5c; color:#fff;
        border:1px solid #1a3a5c; padding:4px 5px;
        font-size:8pt; text-align:center; white-space:nowrap;
    }
    .laporan-page tbody td {
        border:1px solid #bbb; padding:3px 5px;
        vertical-align:top; font-size:8pt; word-break:break-word;
    }
    .laporan-page tbody tr:nth-child(even) td { background:#f5f8ff; }

    /* TTD */
    .laporan-page .ttd-area {
        display:flex; justify-content:space-between; margin-top:8px;
    }
    .laporan-page .ttd-area.single { justify-content:flex-end; }
    .laporan-page .ttd-box { text-align:center; min-width:180px; }
    .laporan-page .ttd-box p { margin:0; font-size:8.5pt; }
    .laporan-page .ttd-space { height:48px; }
    .laporan-page .ttd-nama {
        font-weight:bold; font-size:9pt;
        border-top:1px solid #333; padding-top:2px;
        display:inline-block; min-width:150px; margin-top:2px;
    }

    /* ── CSS PRINT — paling penting ── */
    @media print {
        body * { visibility:hidden !important; }
        #laporanPreviewWrap,
        #laporanPreviewWrap * { visibility:visible !important; }
        #laporanPreviewWrap {
            position:fixed; inset:0; background:#fff;
            padding:0; max-height:none; overflow:visible;
        }
        .laporan-page {
            box-shadow:none;
            margin:0; padding:8mm 10mm 12mm;
            width:100%; max-width:none;
            page-break-after: always;
        }
        .laporan-page:last-child { page-break-after:auto; }
        @page { size:A4 landscape; margin:0; }
    }
    .running-text-wrap {
    width: 100%;
    overflow: hidden;
    background: #1a3a5c;
    padding: 8px 0;
    box-sizing: border-box;
}
.running-text-track {
    display: inline-block;
    white-space: nowrap;
    color: #fff;
    font-weight: 600;
    font-size: .9rem;
    letter-spacing: .5px;
    padding-left: 100%;
    animation: runningText 18s linear infinite;
}
@keyframes runningText {
    0%   { transform: translateX(0); }
    100% { transform: translateX(-100%); }
}
    </style>
</head>
<body>
    <div class="running-text-wrap">
    <div class="running-text-track">SIMRS RSUD KARAWANG &nbsp;&nbsp;•&nbsp;&nbsp; SIMRS RSUD KARAWANG &nbsp;&nbsp;•&nbsp;&nbsp; SIMRS RSUD KARAWANG &nbsp;&nbsp;•&nbsp;&nbsp; SIMRS RSUD KARAWANG</div>
</div>
<div class="container-fluid table-container px-4">
    <div class="card shadow-sm">
        <div class="card-header bg-dark text-white d-flex justify-content-between align-items-center flex-wrap gap-2">
            <h5 class="mb-0">📋 Daftar Laporan Masuk (#LAPOR)</h5>
            <div class="d-flex align-items-center gap-2 flex-wrap">
                <button class="btn-toolbar-action btn-pdf-prev" onclick="openPdfPreview()">
                    📄 Preview / Print
                </button>
                <button class="btn-toolbar-action btn-excel" onclick="exportExcel()">
                    📊 Export Excel
                </button>
                <button class="btn-toolbar-action" onclick="kirimSpreadsheet()"
                        style="border:1px solid #0d6efd;color:#0d6efd;background:#fff;">
                    📤 Kirim ke Spreadsheet
                </button>
                <button class="btn-toolbar-action" onclick="openGrafik()" style="border:1px solid #6f42c1;color:#6f42c1;background:#fff;">
                    📈 Grafik
                </button>
                <small id="status" class="loading">⏳ Memuat data...</small>
            </div>
        </div>

<div class="filter-bar">
    <input type="text" id="filterSearch" placeholder="🔎 Cari isi pesan / nama pelapor..."
        oninput="applySearchFilter()"
        style="min-width:240px;font-size:.82rem;padding:4px 10px;border:1px solid #ced4da;border-radius:6px;">
    <label>Filter:</label>
  <select id="filterStatus" onchange="applyFilter()">
    <option value="">— Semua Status —</option>
    <option value="0">🟡 Open</option>
    <option value="1">🔵 On Progress</option>
    <option value="2">🟢 Closed</option>
    <option value="3">🔴 Perlu Tindak Lanjut</option>   <!-- ⬅️ baru -->
</select>
            <select id="filterDivisi" onchange="applyFilter()">
                <option value="">— Semua Divisi —</option>
                <option value="__none__">🚫 Tidak Terdeteksi</option>
            </select>
            <select id="filterUnit" onchange="applyFilter()">
                <option value="">— Semua Unit —</option>
            </select>
            <label>Dari:</label>
            <input type="date" id="filterTglDari" onchange="applyFilter()">
            <span class="date-sep">s/d</span>
            <input type="date" id="filterTglSampai" onchange="applyFilter()">
            <button class="btn-reset-filter" onclick="resetFilter()">✕ Reset</button>
            <span id="filterInfo" style="font-size:.78rem;color:#888;"></span>
            <select id="filterPetugas" onchange="applyFilter()" style="min-width:150px;margin-left:auto;">
                <option value="">— Semua Petugas —</option>
            </select>
            <label>Tampilkan:</label>
            <select id="perPageSelect" onchange="ubahPerPage(this.value)" style="min-width:80px">
                <option value="10" selected>10</option>
                <option value="25">25</option>
                <option value="50">50</option>
                <option value="100">100</option>
            </select>

        </div>

        <div class="card-body p-0">
            <div class="table-responsive">
                <table class="table table-hover align-middle mb-0">
                    <thead class="table-light">
                        <tr>
                            <th style="width:150px">Waktu</th>
                            <th style="width:125px">Nomor HP</th>
                            <th style="width:155px">Nama Pelapor</th>
                            <th style="width:155px">Unit Pelapor</th>
                            <th>Isi Laporan</th>
                            <th style="width:135px" class="text-center">Divisi</th>
                            <th style="width:100px" class="text-center">Lampiran</th>
                            <th style="width:115px" class="text-center">Action</th>
                        </tr>
                    </thead>
                    <tbody id="table-body">
                        <tr><td colspan="8" class="text-center text-muted py-4">Memuat data...</td></tr>
                    </tbody>
                </table>
            </div>
        </div>
        <div class="card-footer bg-white d-flex justify-content-between align-items-center flex-wrap gap-2">
            <small id="page-info" class="text-muted">-</small>
            <nav><ul class="pagination pagination-sm mb-0" id="pagination"></ul></nav>
        </div>
    </div>
</div>

<!-- MODAL LAMPIRAN -->
<div class="modal fade" id="lampiranModal" tabindex="-1" aria-hidden="true">
    <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content">
            <div class="modal-header">
                <span class="modal-title">📎 Lampiran Laporan</span>
                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="lm-body">
                <div class="lm-sidebar" id="lmSidebar"></div>
                <div class="lm-viewer">
                    <div class="lm-toolbar">
                        <span class="lm-filename" id="lmFilename">—</span>
                        <div id="tbZoom" style="display:none;align-items:center;gap:4px">
                            <button class="tb-btn" onclick="zoomOut()">−</button>
                            <span class="zoom-val" id="zoomVal">100%</span>
                            <button class="tb-btn" onclick="zoomIn()">+</button>
                            <button class="tb-btn" onclick="zoomReset()">↺</button>
                        </div>
                        <div id="tbPdf" style="display:none;align-items:center;gap:4px" class="pdf-nav">
                            <button class="tb-btn" id="pdfPrev" onclick="pdfPrevPage()">‹</button>
                            <span id="pdfPageInfo">— / —</span>
                            <button class="tb-btn" id="pdfNext" onclick="pdfNextPage()">›</button>
                        </div>
                        <a id="tbDownload" href="#" target="_blank" download class="tb-btn" title="Download">⬇</a>
                    </div>
                    <div class="lm-view-area" id="lmViewArea">
                        <div class="lm-loading" id="lmLoading" style="display:none">
                            <div class="spinner"></div> Memuat...
                        </div>
                        <img   id="imgViewer"   src="" alt="" style="display:none">
                        <video id="videoViewer" controls style="display:none"></video>
                        <div   id="pdfWrapper"  style="display:none"></div>
                        <div   id="fileViewer"  style="display:none">
                            <div style="font-size:5rem">📎</div>
                            <p id="fileViewerName" style="margin-top:12px"></p>
                            <a id="fileViewerLink" href="#" target="_blank" class="fi-dlbtn">⬇ Download File</a>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</div>

<!-- MODAL GANTI DIVISI -->
<div class="modal fade" id="divisiModal" tabindex="-1" aria-hidden="true">
    <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content">
            <div class="modal-header">
                <h6 class="modal-title">🏷️ Atur Divisi Laporan</h6>
                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
                <p class="text-muted small mb-1">ID Laporan: <strong id="divisiLaporanId">—</strong></p>
                <p class="text-muted small mb-3">Pengirim: <strong id="divisiLaporanPengirim">—</strong></p>
                <div class="mb-2" style="font-size:.83rem;font-weight:600;color:#444;">Pilih Divisi:</div>
                <div id="divisiOptionList"></div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary btn-sm" data-bs-dismiss="modal">Batal</button>
                <button class="btn btn-primary btn-sm" onclick="simpanDivisi()">💾 Simpan</button>
            </div>
        </div>
    </div>
</div>

<!-- MODAL GANTI UNIT PELAPOR -->
<div class="modal fade" id="unitModal" tabindex="-1" aria-hidden="true">
    <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content">
            <div class="modal-header">
                <h6 class="modal-title">🏥 Atur Unit Pelapor</h6>
                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
                <p class="text-muted small mb-1">ID Laporan: <strong id="unitLaporanId">—</strong></p>
                <p class="text-muted small mb-3">Pengirim: <strong id="unitLaporanPengirim">—</strong></p>
                <input type="text" id="unitSearchBox" placeholder="🔎 Cari unit..." oninput="renderUnitOptionList(this.value)">
                <div class="mb-2" style="font-size:.83rem;font-weight:600;color:#444;">Pilih Unit:</div>
                <div id="unitOptionList"></div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary btn-sm" data-bs-dismiss="modal">Batal</button>
                <button class="btn btn-primary btn-sm" onclick="simpanUnit()">💾 Simpan</button>
            </div>
        </div>
    </div>
</div>

<!-- MODAL PREVIEW PDF -->
<div class="modal fade" id="pdfPrintModal" tabindex="-1" aria-hidden="true">
    <div class="modal-dialog modal-dialog-centered modal-xl">
        <div class="modal-content">
            <div class="modal-header">
                <span class="modal-title">📄 Preview Laporan Helpdesk IT — RSUD Karawang</span>
                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <!-- Toolbar: Cetak | Download PDF | Kirim WA -->
            <div class="pdf-print-toolbar">
                <span id="ppInfo" style="font-size:.82rem;color:#555;flex:1"></span>
                <div class="d-flex gap-2">
                    <button class="btn btn-sm btn-danger" onclick="cetakLaporan()">
                        🖨️ Cetak
                    </button>
                    <button class="btn btn-sm btn-primary" onclick="downloadPdf()" id="btnDownloadPdf">
                        ⬇ Download PDF
                    </button>
                    <button class="btn btn-sm btn-success" onclick="kirimWA()" id="btnKirimWA">
                        📲 Kirim WA
                    </button>
                </div>
            </div>
            <div id="laporanPreviewWrap">
                <div id="laporanPages"></div>
            </div>
        </div>
    </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>

<!-- MODAL GRAFIK ANALITIK -->
<div class="modal fade" id="grafikModal" tabindex="-1" aria-hidden="true">
    <div class="modal-dialog modal-dialog-centered modal-xl">
        <div class="modal-content">
            <div class="modal-header" style="background:#6f42c1;color:#fff;">
                <h6 class="modal-title">📈 Grafik Analitik Laporan</h6>
                <button type="button" class="btn-close" data-bs-dismiss="modal" style="filter:invert(1)"></button>
            </div>
            <div class="modal-body" style="background:#f8f9fa;">
                <!-- Toggle General / Spesifik -->
                <div class="d-flex align-items-center gap-3 mb-3 flex-wrap">
                    <div class="btn-group btn-group-sm" role="group">
                        <button type="button" class="btn btn-purple active" id="btnGeneral" onclick="switchGrafik('general')"
                            style="background:#6f42c1;color:#fff;border-color:#6f42c1;">
                            🏷️ General (per Divisi)
                        </button>
                        <button type="button" class="btn btn-outline-secondary" id="btnSpesifik" onclick="switchGrafik('spesifik')">
                            🔍 Spesifik (per Keyword)
                        </button>
                    </div>
                    <!-- Filter divisi untuk mode spesifik -->
                    <div id="filterSpesifikWrap" style="display:none;align-items:center;gap:8px;">
                        <label style="font-size:.82rem;margin:0;">Pilih Divisi:</label>
                        <select id="grafikDivisiFilter" class="form-select form-select-sm" style="min-width:160px" onchange="renderGrafikSpesifik()">
                            <option value="">— Semua Divisi —</option>
                        </select>
                    </div>
                    <span id="grafikSubtitle" style="font-size:.8rem;color:#888;margin-left:auto;"></span>
                </div>

                <!-- Dua chart side by side -->
                <div class="row g-3">
                    <div class="col-md-6">
                        <div class="card shadow-sm h-100">
                            <div class="card-header py-2" style="font-size:.85rem;font-weight:600;">
                                <span id="chartBarTitle">Jumlah Laporan per Divisi</span>
                            </div>
                            <div class="card-body" style="position:relative;height:320px;">
                                <canvas id="chartBar"></canvas>
                            </div>
                        </div>
                    </div>
                    <div class="col-md-6">
                        <div class="card shadow-sm h-100">
                            <div class="card-header py-2" style="font-size:.85rem;font-weight:600;">
                                <span id="chartPieTitle">Proporsi Laporan</span>
                            </div>
                            <div class="card-body" style="position:relative;height:320px;">
                                <canvas id="chartPie"></canvas>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Tabel ringkasan -->
                <div class="card shadow-sm mt-3">
                    <div class="card-header py-2" style="font-size:.85rem;font-weight:600;">📋 Ringkasan Data</div>
                    <div class="card-body p-0">
                        <div class="table-responsive">
                            <table class="table table-sm table-hover mb-0" id="grafikTabel">
    <thead class="table-dark">
        <tr>
            <th>Kategori</th>
            <th class="text-center">Jumlah</th>
            <th class="text-center">%</th>
            <th class="text-center">Open</th>
            <th class="text-center">Proses</th>
            <th class="text-center">Selesai</th>
            <th class="text-center">Perlu TL</th>   <!-- ⬅️ baru -->
        </tr>
    </thead>
    <tbody id="grafikTabelBody"></tbody>
</table>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</div>

<!-- MODAL TAMBAH LAPORAN MANUAL -->
<div class="modal fade" id="tambahModal" tabindex="-1" aria-hidden="true">
    <div class="modal-dialog modal-dialog-centered" style="max-width:500px">
        <div class="modal-content">
            <div class="modal-header" style="background:#0d6efd;color:#fff;">
                <h6 class="modal-title">📋 Tambah Laporan Manual</h6>
                <button type="button" class="btn-close" data-bs-dismiss="modal" style="filter:invert(1)"></button>
            </div>
            <div class="modal-body">
                <div class="mb-2">
                    <label class="form-label form-label-sm">Nama Pelapor</label>
                    <input type="text" id="tm_nama" class="form-control form-control-sm" placeholder="Nama lengkap">
                </div>
                <div class="mb-2">
                    <label class="form-label form-label-sm">Nomor WA <span class="text-muted">(opsional)</span></label>
                    <input type="text" id="tm_nomor" class="form-control form-control-sm" placeholder="08xx...">
                </div>
                <div class="mb-2">
                    <label class="form-label form-label-sm">Unit / Ruangan <span class="text-muted">(opsional)</span></label>
                    <input type="text" id="tm_unit" class="form-control form-control-sm" placeholder="Nama unit/ruangan">
                </div>
                <div class="mb-2">
                    <label class="form-label form-label-sm">Divisi <span class="text-muted">(opsional)</span></label>
                    <select id="tm_divisi" class="form-select form-select-sm">
                        <option value="">— Deteksi otomatis —</option>
                    </select>
                </div>
                <div class="mb-2">
                    <label class="form-label form-label-sm">Isi Laporan <span class="text-danger">*</span></label>
                    <textarea id="tm_isi" class="form-control form-control-sm" rows="3" placeholder="Deskripsi masalah..."></textarea>
                </div>
                <div class="mb-2">
                    <label class="form-label form-label-sm">Lampiran <span class="text-muted">(opsional, bisa lebih dari 1)</span></label>
                    <input type="file" id="tm_lampiran" class="form-control form-control-sm" multiple accept="image/*,application/pdf,video/*,.doc,.docx,.xls,.xlsx">
                    <div id="tm_lampiran_preview" class="mt-1" style="font-size:.78rem;color:#666;"></div>
                </div>
                <div class="mb-2">
                    <label class="form-label form-label-sm">Nama Operator</label>
                    <input type="text" id="tm_operator" class="form-control form-control-sm" placeholder="Nama petugas input">
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary btn-sm" data-bs-dismiss="modal">Batal</button>
                <button class="btn btn-primary btn-sm" onclick="simpanTambahLaporan()">💾 Simpan & Kirim Notif</button>
            </div>
        </div>
    </div>
</div>

<!-- MODAL SELESAIKAN (dengan input solusi) -->
<div class="modal fade" id="selesaiModal" tabindex="-1" aria-hidden="true">
    <div class="modal-dialog modal-dialog-centered" style="max-width:460px">
        <div class="modal-content">
            <div class="modal-header" style="background:#198754;color:#fff;">
                <h6 class="modal-title">✅ Selesaikan Laporan</h6>
                <button type="button" class="btn-close" data-bs-dismiss="modal" style="filter:invert(1)"></button>
            </div>
            <div class="modal-body">
                <p class="text-muted small mb-3">Laporan ID: <strong id="sl_id">—</strong> | Pelapor: <strong id="sl_nama">—</strong></p>
                <div class="mb-2">
                    <label class="form-label form-label-sm">Catatan Solusi <span class="text-muted">(opsional)</span></label>
                    <textarea id="sl_solusi" class="form-control form-control-sm" rows="3"
                        placeholder="Tulis solusi atau tindakan yang diambil..."></textarea>
                </div>
                <div class="mb-2">
                    <label class="form-label form-label-sm">Nama Operator</label>
                    <input type="text" id="sl_operator" class="form-control form-control-sm" placeholder="Nama petugas">
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary btn-sm" data-bs-dismiss="modal">Batal</button>
                <button class="btn btn-success btn-sm" onclick="konfirmasiSelesai()">✅ Selesaikan & Kirim Notif</button>
            </div>
        </div>
    </div>
</div>

<div class="modal fade" id="upModal" tabindex="-1" aria-hidden="true">
    <div class="modal-dialog modal-dialog-centered" style="max-width:460px">
        <div class="modal-content">
            <div class="modal-header" style="background:#dc3545;color:#fff;">
                <h6 class="modal-title">🔴 Tandai Perlu Tindak Lanjut</h6>
                <button type="button" class="btn-close" data-bs-dismiss="modal" style="filter:invert(1)"></button>
            </div>
            <div class="modal-body">
                <p class="text-muted small mb-3">Laporan ID: <strong id="up_id">—</strong> | Pelapor: <strong id="up_nama">—</strong></p>
                <div class="mb-2">
                    <label class="form-label form-label-sm">Alasan / Keterangan <span class="text-danger">*</span></label>
                    <textarea id="up_alasan" class="form-control form-control-sm" rows="3"
                        placeholder="Contoh: perlu persetujuan kepala IT / butuh perubahan aturan sistem / menunggu vendor..."></textarea>
                </div>
                <div class="mb-2">
                    <label class="form-label form-label-sm">Nama Operator</label>
                    <input type="text" id="up_operator" class="form-control form-control-sm" placeholder="Nama petugas">
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary btn-sm" data-bs-dismiss="modal">Batal</button>
                <button class="btn btn-danger btn-sm" onclick="konfirmasiUp()">🔴 Tandai & Kirim Notif</button>
            </div>
        </div>
    </div>
</div>

<!-- MODAL KIRIM SPREADSHEET -->
<div class="modal fade" id="sheetModal" tabindex="-1" aria-hidden="true">
    <div class="modal-dialog modal-dialog-centered" style="max-width:420px">
        <div class="modal-content">
            <div class="modal-header" style="background:#0d6efd;color:#fff;">
                <h6 class="modal-title">📤 Kirim ke Spreadsheet</h6>
                <button type="button" class="btn-close" data-bs-dismiss="modal" style="filter:invert(1)"></button>
            </div>
            <div class="modal-body">
                <p class="text-muted small mb-3">
                    Data akan dikirim ke tab (sheet) dengan nama di bawah.
                    Kalau nama sheet belum ada, otomatis dibuatkan baru.
                </p>
                <div class="mb-2">
                    <label class="form-label form-label-sm">Nama Sheet <span class="text-danger">*</span></label>
                    <input type="text" id="sheet_nama" class="form-control form-control-sm"
                        placeholder="contoh: agustus-2026">
                </div>
                <small class="text-muted">Total data yang akan dikirim: <strong id="sheet_total_data">0</strong> laporan</small>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary btn-sm" data-bs-dismiss="modal">Batal</button>
                <button class="btn btn-primary btn-sm" onclick="konfirmasiKirimSpreadsheet()">📤 Kirim</button>
            </div>
        </div>
    </div>
</div>

<script>
pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const SERVER_IP   = '10.100.1.220';
const WA_BOT_PORT = 8000;
let PER_PAGE      = 10; // bisa diubah user
// Nomor tujuan kirim WA (tanpa + tanpa 0 di depan, format internasional)
const WA_TARGET   = '6289504683778';

const DIVISI_COLOR = ['primary','success','warning','danger','info','secondary'];
const DIVISI_DOT   = ['#0d6efd','#198754','#ffc107','#dc3545','#0dcaf0','#6c757d'];

const PJ_MAP = {
    'hardware'     : { nama: 'Riky',    jabatan: 'PJ Hardware' },
    'software'     : { nama: 'Husaeni', jabatan: 'PJ Software' },
    'jaringan'     : { nama: 'Zen',     jabatan: 'PJ Jaringan' },
    'implementasi' : { nama: 'Sobari',  jabatan: 'PJ Implementasi' },
};

let allData      = [];
let allDivisi    = [];
let allUnit      = [];
let currentPage  = 1;
let bsModal, bsDivisiModal, bsPdfModal, bsUnitModal;
let imgScale = 1, imgDrag = false, dragX = 0, dragY = 0, scrollX = 0, scrollY = 0;
let pdfDoc = null, pdfPage = 1;
let divisiEditId = null, divisiEditSelected = null;
let unitEditId = null, unitEditSelected = null;

document.addEventListener('DOMContentLoaded', () => {
    bsModal       = new bootstrap.Modal(document.getElementById('lampiranModal'));
    bsDivisiModal = new bootstrap.Modal(document.getElementById('divisiModal'));
    bsUnitModal   = new bootstrap.Modal(document.getElementById('unitModal'));
    bsPdfModal    = new bootstrap.Modal(document.getElementById('pdfPrintModal'));

    document.getElementById('table-body').addEventListener('click', e => {
        const lihat = e.target.closest('.btn-lihat');
        if (lihat) { openLampiran(JSON.parse(lihat.dataset.files)); return; }
        const bdv = e.target.closest('.btn-divisi, .btn-divisi-none');
        if (bdv)  { openDivisiModal(parseInt(bdv.dataset.id), bdv.dataset.pengirim, bdv.dataset.kddivisi); return; }
        const bun = e.target.closest('.btn-unit');
        if (bun)  { openUnitModal(parseInt(bun.dataset.id), bun.dataset.pengirim, bun.dataset.kdunit); return; }
    });
    document.getElementById('lmSidebar').addEventListener('click', e => {
        const item = e.target.closest('.lm-file-item');
        if (!item) return;
        selectFile(parseInt(item.dataset.idx),
            JSON.parse(document.getElementById('lmSidebar').dataset.files || '[]'));
    });

    setupDrag();
    loadData();
    setInterval(loadData, 5000);
});

// ── Filter ────────────────────────────────────────────────────────
function applyFilter() { currentPage = 1; loadData(); }
function applySearchFilter() { currentPage = 1; renderPage(1); }
function resetFilter() {
    ['filterStatus','filterDivisi','filterPetugas','filterUnit','filterSearch'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
    });
    ['filterTglDari','filterTglSampai'].forEach(id => document.getElementById(id).value = '');
    currentPage = 1; loadData();
}
function buildQueryString() {
    const p = new URLSearchParams();
    const st = document.getElementById('filterStatus').value;
    const dv = document.getElementById('filterDivisi').value;
    const d1 = document.getElementById('filterTglDari').value;
    const d2 = document.getElementById('filterTglSampai').value;
    if (st) p.set('status', st);
    if (dv && dv !== '__none__') p.set('divisi', dv);
    if (d1) p.set('tgl_dari', d1);
    if (d2) p.set('tgl_sampai', d2);
    return p.toString() ? '?' + p.toString() : '';
}
function updateFilterInfo() {
    const st = document.getElementById('filterStatus');
    const dv = document.getElementById('filterDivisi');
    const pt = document.getElementById('filterPetugas');
    const ut = document.getElementById('filterUnit');
    const d1 = document.getElementById('filterTglDari').value;
    const d2 = document.getElementById('filterTglSampai').value;
    const parts = [];
    if (st.value) parts.push(st.options[st.selectedIndex].text);
    if (dv.value) parts.push(dv.options[dv.selectedIndex].text);
    if (pt?.value) parts.push('Petugas: ' + pt.value);
    if (ut?.value) parts.push('Unit: ' + ut.value);
    if (d1) parts.push('Dari: ' + d1);
    if (d2) parts.push('S/d: '  + d2);
    document.getElementById('filterInfo').textContent = parts.length ? `Filter: ${parts.join(', ')}` : '';
}
function populateDivisiDropdown(list) {
    allDivisi = list;
    const sel = document.getElementById('filterDivisi');
    const cur = sel.value;
    // Pertahankan 2 opsi pertama: "Semua Divisi" & "Tidak Terdeteksi", hapus sisanya
    while (sel.options.length > 2) sel.remove(2);
    list.forEach(d => sel.add(new Option(d.name, d.kd_divisi)));
    sel.value = cur;
}
function populatePetugasFromServer(list) {
    const sel = document.getElementById('filterPetugas');
    const cur = sel.value;
    while (sel.options.length > 1) sel.remove(1);
    (list||[]).forEach(p => sel.add(new Option(p, p)));
    if (cur) sel.value = cur;
}
function populateUnitDropdown(data) {
    const sel = document.getElementById('filterUnit');
    if (!sel) return;
    const cur = sel.value;
    const units = [...new Set((data||[])
        .map(d => (d.unit || '').trim())
        .filter(u => u))].sort((a, b) => a.localeCompare(b, 'id'));
    while (sel.options.length > 1) sel.remove(1);
    units.forEach(u => sel.add(new Option(u, u)));
    if (cur) sel.value = cur;
}
function getActiveDivisiName() {
    const sel = document.getElementById('filterDivisi');
    if (!sel.value) return null;
    return sel.options[sel.selectedIndex].text.toLowerCase().trim();
}

// ── Load data ─────────────────────────────────────────────────────
async function loadData() {
    const st = document.getElementById('status');
    try {
        const res  = await fetch('get_messages.php' + buildQueryString());
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        if (json.error) { st.className='offline'; st.textContent='❌ ' + json.error; return; }
        if (json.divisi) populateDivisiDropdown(json.divisi);
        if (json.petugas) populatePetugasFromServer(json.petugas);
        if (json.unit_list) allUnit = json.unit_list;
        allData = json.messages || [];
        populateUnitDropdown(allData);
        updateFilterInfo();
        st.className = 'online';
        st.textContent = `✅ Online · ${allData.length} laporan · ${new Date().toLocaleTimeString('id-ID')}`;
        renderPage(currentPage);
    } catch(err) {
        st.className = 'offline'; st.textContent = '❌ Koneksi gagal';
        console.error('loadData:', err);
    }
}

// ── Render tabel ──────────────────────────────────────────────────
function renderPage(page) {
    const petugasFilter = document.getElementById('filterPetugas')?.value?.trim() || '';
    const unitFilter     = document.getElementById('filterUnit')?.value?.trim() || '';
    const divisiFilter   = document.getElementById('filterDivisi')?.value || '';
    const searchQuery    = (document.getElementById('filterSearch')?.value || '').trim().toLowerCase();

    let displayData = allData;
    if (petugasFilter) displayData = displayData.filter(d => (d.petugas||'').trim() === petugasFilter);
    if (unitFilter)    displayData = displayData.filter(d => (d.unit||'').trim() === unitFilter);
    if (divisiFilter === '__none__') displayData = displayData.filter(d => !d.kd_divisi && !d.nama_divisi);
    if (searchQuery) {
        displayData = displayData.filter(d => {
            const isi   = (d.isi_pesan || '').toLowerCase();
            const nama  = (d.nama_user || d.pengirim || '').toLowerCase();
            const nomor = (d.nomor_pengirim || '').toLowerCase();
            return isi.includes(searchQuery) || nama.includes(searchQuery) || nomor.includes(searchQuery);
        });
    }
    const total = Math.max(1, Math.ceil(displayData.length / PER_PAGE));
    currentPage = Math.min(Math.max(1, page), total);
    const start = (currentPage - 1) * PER_PAGE;
    const slice = displayData.slice(start, start + PER_PAGE);
    const tbody = document.getElementById('table-body');

    document.getElementById('page-info').textContent = displayData.length === 0
        ? 'Tidak ada data'
        : `Menampilkan ${start+1}–${start+slice.length} dari ${displayData.length} laporan`;

    if (!displayData.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted py-4">Belum ada laporan masuk.</td></tr>';
        renderPagination(total); return;
    }

    tbody.innerHTML = slice.map(item => {
        const st = parseInt(item.status_selesai) || 0;
        const rowClass = st===0 ? 'row-baru' : st===1 ? 'row-proses' : st===3 ? 'row-up' : 'row-selesai';
        const namaE = h(item.nama_user || item.pengirim || 'Anonim');

        let actionBtn;
        if (st === 0) {
            actionBtn = `<button class="btn btn-warning btn-sm text-white"
                onclick="updateStatusProses(${item.id},'${item.nomor_pengirim}','${namaE}')">▶ Proses</button>`;
        } else if (st === 1) {
            actionBtn = `<div class="d-flex gap-1 justify-content-center">
                <button class="btn btn-success btn-sm"
                    onclick="bukaModalSelesai(${item.id},'${namaE}','${item.nomor_pengirim}')" title="Selesaikan">✅</button>
                <button class="btn btn-danger btn-sm"
                    onclick="bukaModalUp(${item.id},'${namaE}','${item.nomor_pengirim}')" title="Perlu Tindak Lanjut">🔴</button>
            </div>`;
        } else if (st === 3) {
            actionBtn = `<span class="badge bg-danger px-3 py-2">🔴 Perlu TL</span>`;
        } else {
            actionBtn = `<span class="badge bg-success px-3 py-2">✓ Selesai</span>`;
        }

        const waktu = `
            <div class="time-info text-muted">${item.waktu||'-'}</div>
            ${item.tgl_proses    ? `<div class="time-info text-warning">▶ ${item.tgl_proses}</div>` : ''}
            ${item.tgl_eskalasi  ? `<div class="time-info text-danger">🔴 ${item.tgl_eskalasi}</div>` : ''}
            ${item.tgl_selesai   ? `<div class="time-info text-success">✔ ${item.tgl_selesai}</div>` : ''}`;

        const namaDisplay = item.nama_user || item.pengirim || 'Anonim';
        return `<tr class="${rowClass}">
            <td>${waktu}</td>
            <td><span class="badge bg-info text-dark badge-number">${h(item.nomor_pengirim)}</span></td>
            <td><strong>${h(namaDisplay)}</strong></td>
            <td>${buildUnitBtn(item)}</td>
            <td>${h(item.isi_pesan)}</td>
            <td class="text-center">${buildDivisiBtn(item)}</td>
            <td class="text-center">${buildAttBtn(item.attachments)}</td>
            <td class="text-center">${actionBtn}</td>
        </tr>`;
    }).join('');

    renderPagination(total);
}

function buildDivisiBtn(item) {
    const pen = h(item.pengirim || 'Anonim');
    if (!item.nama_divisi) {
        return `<button class="btn-divisi-none" data-id="${item.id}" data-pengirim="${pen}" data-kddivisi="">✏️ Atur Divisi</button>`;
    }
    const idx = Math.max(0, (parseInt(item.kd_divisi)||1) - 1) % DIVISI_COLOR.length;
    return `<button class="btn-divisi badge bg-${DIVISI_COLOR[idx]}"
                data-id="${item.id}" data-pengirim="${pen}" data-kddivisi="${item.kd_divisi||''}">
                ${h(item.nama_divisi)} ✏️
            </button>`;
}
function buildUnitBtn(item) {
    const pen = h(item.pengirim || 'Anonim');
    const kdUnit = item.kd_unit_pelapor || '';
    const label = item.unit ? h(item.unit) : 'Atur unit';
    const emptyClass = item.unit ? '' : ' btn-unit-empty';
    return `<button class="btn-unit${emptyClass}" data-id="${item.id}" data-pengirim="${pen}" data-kdunit="${kdUnit}" title="Klik untuk ubah unit pelapor">
                <span>${label}</span><span class="unit-pencil">✏️</span>
            </button>`;
}
function buildAttBtn(attachments) {
    if (!attachments || !attachments.length) return '<span class="text-muted small">—</span>';
    const safe = JSON.stringify(attachments).replace(/"/g,'&quot;');
    return `<button class="btn-lihat" data-files="${safe}">
                👁 Lihat${attachments.length > 1 ? ` <span class="badge-att">${attachments.length}</span>` : ''}
            </button>`;
}

// ── Modal Ganti Divisi ────────────────────────────────────────────
function openDivisiModal(id, pengirim, kdSaat) {
    divisiEditId       = id;
    divisiEditSelected = kdSaat !== '' && kdSaat ? parseInt(kdSaat) : null;
    document.getElementById('divisiLaporanId').textContent       = '#' + id;
    document.getElementById('divisiLaporanPengirim').textContent = pengirim;

    let html = `<div class="divisi-option-none ${divisiEditSelected === null ? 'selected' : ''}"
                    onclick="selectDivisiOpt(null,this)">
                    <span>🚫</span><span class="divisi-name">Tanpa Divisi</span>
                </div>`;
    allDivisi.forEach(d => {
        const i   = Math.max(0,(parseInt(d.kd_divisi)-1)) % DIVISI_DOT.length;
        const sel = divisiEditSelected === parseInt(d.kd_divisi);
        html += `<div class="divisi-option ${sel?'selected':''}" onclick="selectDivisiOpt(${d.kd_divisi},this)">
                    <span class="divisi-dot" style="background:${DIVISI_DOT[i]}"></span>
                    <span class="divisi-name">${h(d.name)}</span>
                    <span class="divisi-kd">ID: ${d.kd_divisi}</span>
                </div>`;
    });
    document.getElementById('divisiOptionList').innerHTML = html;
    bsDivisiModal.show();
}
function selectDivisiOpt(kd, el) {
    divisiEditSelected = kd;
    document.querySelectorAll('#divisiOptionList .divisi-option, #divisiOptionList .divisi-option-none')
        .forEach(e => e.classList.remove('selected'));
    el.classList.add('selected');
}
async function simpanDivisi() {
    if (!divisiEditId) return;
    try {
        const res = await fetch('get_messages.php', {
            method : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body   : JSON.stringify({ action: 'update_divisi', id: divisiEditId, kd_divisi: divisiEditSelected })
        });
        const r = await res.json();
        if (r.success) { bsDivisiModal.hide(); await loadData(); }
        else alert('Gagal simpan divisi: ' + r.error);
    } catch(e) { alert('Gagal update divisi: ' + e.message); }
}

// ── Modal Ganti Unit Pelapor ───────────────────────────────────────
function openUnitModal(id, pengirim, kdSaat) {
    unitEditId       = id;
    unitEditSelected = kdSaat !== '' && kdSaat ? parseInt(kdSaat) : null;
    document.getElementById('unitLaporanId').textContent       = '#' + id;
    document.getElementById('unitLaporanPengirim').textContent = pengirim;
    document.getElementById('unitSearchBox').value = '';
    renderUnitOptionList('');
    bsUnitModal.show();
}
function renderUnitOptionList(keyword) {
    const kw = (keyword || '').toLowerCase().trim();
    let html = `<div class="unit-option-none ${unitEditSelected === null ? 'selected' : ''}"
                    onclick="selectUnitOpt(null,this)">
                    <span>🚫</span><span class="unit-name">Tanpa Unit</span>
                </div>`;
    const filtered = allUnit.filter(u => !kw || u.nama_unit.toLowerCase().includes(kw));
    filtered.forEach(u => {
        const sel = unitEditSelected === parseInt(u.kd_unit);
        html += `<div class="unit-option ${sel?'selected':''}" onclick="selectUnitOpt(${u.kd_unit},this)">
                    <span>🏥</span>
                    <span class="unit-name">${h(u.nama_unit)}</span>
                </div>`;
    });
    if (!filtered.length) {
        html += `<p class="text-muted small text-center py-2">Tidak ada unit yang cocok.</p>`;
    }
    document.getElementById('unitOptionList').innerHTML = html;
}
function selectUnitOpt(kd, el) {
    unitEditSelected = kd;
    document.querySelectorAll('#unitOptionList .unit-option, #unitOptionList .unit-option-none')
        .forEach(e => e.classList.remove('selected'));
    el.classList.add('selected');
}
async function simpanUnit() {
    if (!unitEditId) return;
    try {
        const res = await fetch('get_messages.php', {
            method : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body   : JSON.stringify({ action: 'update_unit', id: unitEditId, kd_unit: unitEditSelected })
        });
        const r = await res.json();
        if (r.success) { bsUnitModal.hide(); await loadData(); }
        else alert('Gagal simpan unit: ' + r.error);
    } catch(e) { alert('Gagal update unit: ' + e.message); }
}

// ── BUILD TTD ──────────────────────────────────────────────────────
function buildTtdHtml(tgl) {
    const divisiAktif = getActiveDivisiName();
    const pj = divisiAktif ? PJ_MAP[divisiAktif] : null;
    const ttdKiri = `
        <div class="ttd-box">
            <p>Mengetahui,</p>
 
            <div class="ttd-space"></div>
            <div class="ttd-nama">dr. Ucu Nurhadiat</div>
            <p style="font-size:8pt;color:#555;margin-top:2px;">Kepala Instalasi IT</p>
        </div>`;
    if (pj) {
        return `<div class="ttd-area">${ttdKiri}
            <div class="ttd-box">
                <p>Karawang, ${tgl}</p>
                <div class="ttd-space"></div>
                <div class="ttd-nama">${h(pj.nama)}</div>
                <p style="font-size:8pt;color:#555;margin-top:2px;">${h(pj.jabatan)}</p>
            </div></div>`;
    }
    return `<div class="ttd-area single">${ttdKiri}</div>`;
}

// ── BUILD ROWS untuk tabel cetak ──────────────────────────────────
// Dibagi per halaman agar tidak terpotong antar page
const ROWS_PER_PAGE = 25; // baris per halaman cetak

function buildLaporanPages() {
    const tgl = new Date().toLocaleDateString('id-ID', {
        day:'2-digit', month:'long', year:'numeric', timeZone:'Asia/Jakarta'
    });
    const d1 = document.getElementById('filterTglDari').value;
    const d2 = document.getElementById('filterTglSampai').value;
    const fmt = v => v ? new Date(v).toLocaleDateString('id-ID',{day:'2-digit',month:'long',year:'numeric'}) : '...';
    const periodeStr = (d1||d2) ? `${fmt(d1)} s/d ${fmt(d2)}` : 'Semua Periode';
    const filterInfo = document.getElementById('filterInfo').textContent;

    // Bagi data ke halaman-halaman
    const pages = [];
    for (let i = 0; i < allData.length; i += ROWS_PER_PAGE) {
        pages.push(allData.slice(i, i + ROWS_PER_PAGE));
    }
    if (!pages.length) pages.push([]);

    const totalPages = pages.length;

    return pages.map((pageData, pageIdx) => {
        const startNo = pageIdx * ROWS_PER_PAGE + 1;
       const STATUS_BADGE = {
            0: { bg:'#fff3cd', text:'#856404', label:'Open'        },
            1: { bg:'#cfe2ff', text:'#084298', label:'On Progress' },
            2: { bg:'#d1e7dd', text:'#0f5132', label:'Selesai'     },
            3: { bg:'#f8d7da', text:'#842029', label:'Perlu TL'    },
        };
        const rows = pageData.map((item, i) => {
            const namaDisplay = item.unit || '—';
            const userDisplay = item.nama_user || item.pengirim || '—';
            const st = parseInt(item.status_selesai) || 0;
            const sb = STATUS_BADGE[st] || STATUS_BADGE[0];
            return `<tr>
                <td style="text-align:center;width:20px">${startNo + i}</td>
                <td style="width:70px">${h(namaDisplay)}</td>
                <td style="width:80px">${h(userDisplay)}</td>
                <td style="width:70px;white-space:nowrap">${item.waktu||'—'}</td>
                <td style="width:70px;white-space:nowrap">${item.tgl_proses||'—'}</td>
                <td style="width:70px;white-space:nowrap">${item.tgl_selesai||'—'}</td>
                <td style="text-align:center;width:42px">${item.durasi||'—'}</td>
                <td style="width:60px">${h(item.nama_divisi||'—')}</td>
                <td>${h(item.isi_pesan||'—')}</td>
                <td style="width:95px">${h(item.solusi||'—')}</td>
                <td style="width:55px">${h(item.petugas_dilaporkan||'—')}</td>
                <td style="width:55px">${h(item.petugas_menyelesaikan||'—')}</td>
                <td style="text-align:center;width:55px;background:${sb.bg};color:${sb.text};font-weight:bold;border-radius:3px;">${sb.label}</td>
            </tr>`;
        }).join('');

        // TTD hanya di halaman terakhir
        const ttdHtml = (pageIdx === totalPages - 1) ? buildTtdHtml(tgl) : '';

        return `<div class="laporan-page">
            <div class="kop">
                <h2>Laporan Helpdesk IT</h2>
                <p>RSUD Karawang &nbsp;|&nbsp; Periode: ${periodeStr}${filterInfo ? ' &nbsp;|&nbsp; ' + filterInfo : ''}</p>
            </div>
            <div class="meta-row">
                <span>Total: ${allData.length} laporan</span>
                <span>Halaman ${pageIdx+1} / ${totalPages} &nbsp;|&nbsp; Dicetak: ${new Date().toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})}</span>
            </div>
            <table>
               <thead>
    <tr>
        <th rowspan="2">No</th>
        <th rowspan="2">Ruangan</th>
        <th rowspan="2">Nama User</th>
        <th rowspan="2">Tgl Lapor</th>
        <th rowspan="2">Tgl Respon</th>
        <th rowspan="2">Tgl Selesai</th>
        <th rowspan="2">Durasi</th>
        <th rowspan="2">Divisi</th>
        <th rowspan="2">Masalah</th>
        <th rowspan="2">Solusi</th>
        <th colspan="2">Petugas yang</th>
        <th rowspan="2">Status</th>
    </tr>
    <tr>
        <th>Dilaporkan</th>
        <th>Menyelesaikan</th>
    </tr>
</thead>
                <tbody>
${rows || '<tr><td colspan="12" style="text-align:center;padding:10px;color:#888">Tidak ada data</td></tr>'}
                </tbody>
            </table>
            ${ttdHtml}
        </div>`;
    }).join('');
}

// ── Preview & Print ───────────────────────────────────────────────
function openPdfPreview() {
    if (!allData.length) { alert('Tidak ada data untuk di-preview.'); return; }
    document.getElementById('laporanPages').innerHTML = buildLaporanPages();
    document.getElementById('ppInfo').textContent =
        `Total: ${allData.length} laporan · ${document.getElementById('filterInfo').textContent || 'Semua filter'}`;
    bsPdfModal.show();
}
function cetakLaporan() {
    // Cetak via jsPDF agar hasil sama persis dengan Download PDF
    // Buka PDF di tab baru → browser print dialog otomatis muncul
    const btn = event?.target;
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Menyiapkan...'; }
    try {
        const pdfBlob = buildPdfBlob();
        const url = URL.createObjectURL(pdfBlob);
        const win = window.open(url, '_blank');
        if (win) {
            win.addEventListener('load', () => {
                win.print();
                setTimeout(() => URL.revokeObjectURL(url), 30000);
            });
        } else {
            alert('Popup diblokir browser. Gunakan tombol Download PDF lalu print manual.');
            URL.revokeObjectURL(url);
        }
    } catch(e) {
        alert('Gagal: ' + e.message);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🖨️ Cetak'; }
    }
}

// ── Helper: build PDF blob (dipakai cetak, download, kirim WA) ──────
// ── Helper: build PDF blob (dipakai cetak, download, kirim WA) ──────
function buildPdfBlob() {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation:'landscape', unit:'mm', format:'a4' });

    const d1 = document.getElementById('filterTglDari').value;
    const d2 = document.getElementById('filterTglSampai').value;
    const fmt = v => v ? new Date(v).toLocaleDateString('id-ID',{day:'2-digit',month:'long',year:'numeric'}) : '...';
    const periodeStr = (d1||d2) ? `${fmt(d1)} s/d ${fmt(d2)}` : 'Semua Periode';
    const tglCetak   = new Date().toLocaleString('id-ID', { timeZone:'Asia/Jakarta' });

    const divisiAktif = getActiveDivisiName();
    const pj          = divisiAktif ? PJ_MAP[divisiAktif] : null;

    const tglTtd = new Date().toLocaleDateString('id-ID', {
        day:'2-digit', month:'long', year:'numeric', timeZone:'Asia/Jakarta'
    });
    const tglFinal = `Karawang, ${tglTtd}`;

    // ── Label & warna status ──────────────────────────────────────
    const STATUS_LABEL = ['Open', 'On Progress', 'Selesai', 'Perlu TL']; 
    const STATUS_COLOR = {
        0: { fill: [255, 243, 205], text: [133, 100, 4]  }, // kuning (Open)
        1: { fill: [207, 226, 255], text: [8, 66, 152]   }, // biru (Process)
        2: { fill: [209, 231, 221], text: [15, 81, 50]   }, // hijau (Selesai)
         3: { fill: [248, 215, 218], text: [132, 32, 41]  }, //merah
    };

        const STATUS_COL_INDEX = 12; // kolom terakhir (geser +1 karena Petugas dipecah 2)

    const tableRows = allData.map((item, i) => {
        const st = parseInt(item.status_selesai) || 0;
        return [
            i + 1,
            (item.unit        || '—').substring(0, 30),
            (item.nama_user   || item.pengirim || '—').substring(0, 30),
            item.waktu        || '—',
            item.tgl_proses   || '—',
            item.tgl_selesai  || '—',
            item.durasi       || '—',
            (item.nama_divisi || '—').substring(0, 20),
            (item.isi_pesan   || '—').substring(0, 150),
            (item.solusi      || '—').substring(0, 100),
            (item.petugas_dilaporkan     || '—').substring(0, 18),
            (item.petugas_menyelesaikan  || '—').substring(0, 18),
            STATUS_LABEL[st] || 'Open',
        ];
    });

    const marginBottom = 42;

        doc.autoTable({
        head: [
            [
                { content:'No',          rowSpan:2 },
                { content:'Ruangan',     rowSpan:2 },
                { content:'Nama User',   rowSpan:2 },
                { content:'Tgl Lapor',   rowSpan:2 },
                { content:'Tgl Respon',  rowSpan:2 },
                { content:'Tgl Selesai', rowSpan:2 },
                { content:'Durasi',      rowSpan:2 },
                { content:'Divisi',      rowSpan:2 },
                { content:'Masalah',     rowSpan:2 },
                { content:'Solusi',      rowSpan:2 },
                { content:'Petugas yang', colSpan:2, styles:{ halign:'center' } },
                { content:'Status',      rowSpan:2 },
            ],
            [
                { content:'Dilaporkan' },
                { content:'Menyelesaikan' },
            ]
        ],
        body: tableRows,
        startY: 26,
        styles: {
            fontSize: 6.8, cellPadding: 2,
            overflow: 'linebreak', valign: 'top',
            font: 'helvetica',
        },
        headStyles: {
            fillColor: [26, 58, 92], textColor: 255,
            fontStyle: 'bold', fontSize: 7.2, halign: 'center',
        },
        alternateRowStyles: { fillColor: [245, 248, 255] },
        columnStyles: {
            0:  { cellWidth: 7,  halign:'center' },
            1:  { cellWidth: 20 },
            2:  { cellWidth: 20 },
            3:  { cellWidth: 18, halign:'center' },
            4:  { cellWidth: 18, halign:'center' },
            5:  { cellWidth: 18, halign:'center' },
            6:  { cellWidth: 12, halign:'center' },
            7:  { cellWidth: 16 },
            8:  { cellWidth: 'auto' },
            9:  { cellWidth: 24 },
            10: { cellWidth: 15 },   // Petugas Dilaporkan
            11: { cellWidth: 15 },   // Petugas Menyelesaikan
            12: { cellWidth: 16, halign:'center' },  // Status
        },
        margin: { top: 26, left: 8, right: 8, bottom: marginBottom },
        didParseCell: (data) => {
            // Beri warna khusus untuk kolom Status di baris data (bukan header)
            if (data.section === 'body' && data.column.index === STATUS_COL_INDEX) {
                const item = allData[data.row.index];
                const st = parseInt(item?.status_selesai) || 0;
                const c = STATUS_COLOR[st] || STATUS_COLOR[0];
                data.cell.styles.fillColor = c.fill;
                data.cell.styles.textColor = c.text;
                data.cell.styles.fontStyle = 'bold';
            }
        },
        didDrawPage: (data) => {
            const pg  = data.pageNumber;
            const tot = doc.internal.getNumberOfPages();
            doc.setFontSize(13); doc.setFont('helvetica','bold');
            doc.setTextColor(26, 58, 92);
            doc.text('LAPORAN HELPDESK IT', 148.5, 10, { align:'center' });
            doc.setFontSize(8); doc.setFont('helvetica','normal');
            doc.setTextColor(100);
            doc.text(`RSUD Karawang  |  Periode: ${periodeStr}`, 148.5, 16, { align:'center' });
            doc.setDrawColor(26,58,92); doc.setLineWidth(0.4);
            doc.line(8, 18, 289, 18);
            doc.setFontSize(6.5); doc.setTextColor(130);
            doc.text(`Total: ${allData.length} laporan`, 8, 23);
            doc.text(`Halaman ${pg} / ${tot}   |   Dicetak: ${tglCetak}`, 289, 23, { align:'right' });
            doc.setDrawColor(200); doc.setLineWidth(0.3);
            doc.line(8, 196, 289, 196);
            doc.setFontSize(6); doc.setTextColor(160);
            doc.text('Instalasi IT — RSUD Karawang', 148.5, 200, { align:'center' });
        },
    });

    const ttdY = 163;

    const drawTtd = (xCenter, judulTtd, namaTtd, jabatanTtd) => {
        doc.setFontSize(8); doc.setFont('helvetica','normal'); doc.setTextColor(50);
        doc.text(judulTtd, xCenter, ttdY, { align:'center' });
        const garisY = ttdY + 23;
        doc.setDrawColor(60); doc.setLineWidth(0.3);
        doc.line(xCenter - 30, garisY, xCenter + 30, garisY);
        doc.setFontSize(8.5); doc.setFont('helvetica','bold'); doc.setTextColor(20);
        doc.text(namaTtd, xCenter, garisY + 4, { align:'center' });
        doc.setFontSize(7.5); doc.setFont('helvetica','normal'); doc.setTextColor(90);
        doc.text(jabatanTtd, xCenter, garisY + 9, { align:'center' });
    };

    if (pj) {
        drawTtd(70, 'Mengetahui,',     'dr. Ucu Nurhadiat', 'Kepala Instalasi IT');
        drawTtd(220,  tglFinal, pj.nama,           pj.jabatan);
    } else {
        drawTtd(220, 'Mengetahui,', 'dr. Ucu Nurhadiat', 'Kepala Instalasi IT');
    }

    return doc.output('blob');
}

// ── Download PDF ──────────────────────────────────────────────────
function downloadPdf() {
    const btn = document.getElementById('btnDownloadPdf');
    btn.disabled = true; btn.textContent = '⏳ Membuat PDF...';
    try {
        const blob   = buildPdfBlob();
        const url    = URL.createObjectURL(blob);
        const a      = document.createElement('a');
        const tglFile = new Date().toLocaleDateString('id-ID').replace(/\//g,'-');
        a.href = url; a.download = `laporan_helpdesk_${tglFile}.pdf`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch(e) {
        alert('Gagal buat PDF: ' + e.message);
        console.error(e);
    } finally {
        btn.disabled = false; btn.textContent = '⬇ Download PDF';
    }
}

// ── Kirim WA: teks ringkasan + file PDF ──────────────────────────
async function kirimWA() {
    const btn = document.getElementById('btnKirimWA');
    if (!confirm(`Kirim ringkasan + file PDF ke WhatsApp ${WA_TARGET}?`)) return;
    btn.disabled = true; btn.textContent = '⏳ Mengirim...';

    try {
        const d1 = document.getElementById('filterTglDari').value;
        const d2 = document.getElementById('filterTglSampai').value;
        const fmt = v => v ? new Date(v).toLocaleDateString('id-ID') : '?';

        const total   = allData.length;
        const open    = allData.filter(d => parseInt(d.status_selesai)===0).length;
        const proses  = allData.filter(d => parseInt(d.status_selesai)===1).length;
        const selesai = allData.filter(d => parseInt(d.status_selesai)===2).length;
        const periode = (d1||d2) ? `${fmt(d1)} s/d ${fmt(d2)}` : 'Semua periode';

        const pesan =
            `📋 *Laporan Helpdesk IT — RSUD Karawang*\n` +
            `━━━━━━━━━━━━━━━━━\n` +
            `📅 Periode: ${periode}\n` +
            `📊 Total laporan: *${total}*\n` +
            `🟡 Open       : *${open}*\n` +
            `🔵 On Progress: *${proses}*\n` +
            `🟢 Selesai    : *${selesai}*\n` +
            `━━━━━━━━━━━━━━━━━\n` +
            `🕐 ${new Date().toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})}`;

        // ── Kirim teks dulu ──
        // Helper: parse response dengan aman (antisipasi HTML error dari server)
        const safeJson = async (response) => {
            const text = await response.text();
            try { return JSON.parse(text); }
            catch(e) { throw new Error('Server error: ' + text.substring(0, 200)); }
        };

        const resText = await fetch(`http://${SERVER_IP}:${WA_BOT_PORT}/send-reply`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nomor: WA_TARGET, pesan })
        });
        const rText = await safeJson(resText);
        if (!rText.success) throw new Error('Gagal kirim teks: ' + (rText.error||''));

        // ── Generate PDF lalu kirim sebagai file ──
        const pdfBlob = buildPdfBlob();
        const tglFile = new Date().toLocaleDateString('id-ID').replace(/\//g,'-');
        const formData = new FormData();
        formData.append('nomor', WA_TARGET);
        formData.append('caption', `📄 Laporan Helpdesk IT — ${periode}`);
        formData.append('pdf', pdfBlob, `laporan_helpdesk_${tglFile}.pdf`);

        const resPdf = await fetch(`http://${SERVER_IP}:${WA_BOT_PORT}/send-pdf`, {
            method: 'POST',
            body: formData
        });
        const rPdf = await safeJson(resPdf);
        if (!rPdf.success) throw new Error('Gagal kirim PDF: ' + (rPdf.error||''));

        alert('✅ Teks + file PDF berhasil dikirim ke WhatsApp!');
    } catch(e) {
        alert('❌ ' + e.message);
        console.error(e);
    } finally {
        btn.disabled = false; btn.textContent = '📲 Kirim WA';
    }
}

// ── Export Excel ──────────────────────────────────────────────────
// ── Export Excel ──────────────────────────────────────────────────
// Ganti fungsi exportExcel() yang lama dengan ini.
// TTD tetap di sheet yang sama, menggunakan kolom A–G (kiri)
// dan kolom I–K (kanan) agar sejajar dalam lebar tabel data.
function exportExcel() {
    if (!allData.length) { alert('Tidak ada data untuk diekspor.'); return; }

    const statusLabel = {0:'Open', 1:'On Progress', 2:'Closed', 3:'Perlu Tindak Lanjut'}; 

    const tglTtd      = new Date().toLocaleDateString('id-ID', {
        day:'2-digit', month:'long', year:'numeric', timeZone:'Asia/Jakarta'
    });
    const divisiAktif = getActiveDivisiName();
    const pj          = divisiAktif ? PJ_MAP[divisiAktif] : null;
    const d1          = document.getElementById('filterTglDari').value;
    const d2          = document.getElementById('filterTglSampai').value;
    const fmtTgl      = v => v ? new Date(v).toLocaleDateString('id-ID',{day:'2-digit',month:'long',year:'numeric'}) : '—';
    const periodeStr  = (d1||d2) ? `${fmtTgl(d1)} s/d ${fmtTgl(d2)}` : 'Semua Periode';

    // 11 kolom total (index 0–10): A=No, B=Ruangan, C=Nama, D=TglLapor,
    // E=TglRespon, F=Durasi, G=Divisi, H=Masalah, I=Solusi, J=Petugas, K=Status
        // 12 kolom total (index 0–11)
    const COL_LAST = 11;

    const aoa = [
        ['LAPORAN HELPDESK IT — RSUD KARAWANG'],
        [`Periode: ${periodeStr}   |   Total: ${allData.length} laporan   |   Dicetak: ${tglTtd}`],
        [],
        // Header baris 1 (row index 3)
        ['No','Ruangan','Nama User','Tgl Lapor','Tgl Respon','Durasi',
         'Divisi','Masalah','Solusi','Petugas yang','', 'Status'],
        // Header baris 2 (row index 4) — hanya kolom Petugas yang punya sub-label
        ['','','','','','','','','','Dilaporkan','Menyelesaikan',''],
    ];

    allData.forEach((item, i) => {
        aoa.push([
            i + 1,
            item.unit        || '-',
            item.nama_user   || item.pengirim || 'Anonim',
            item.waktu       || '-',
            item.tgl_proses  || '-',
            item.durasi      || '-',
            item.nama_divisi || '-',
            item.isi_pesan   || '-',
            item.solusi      || '-',
            item.petugas_dilaporkan    || '-',
            item.petugas_menyelesaikan || '-',
            statusLabel[parseInt(item.status_selesai)] || 'Open',
        ]);
    });

    aoa.push([]);
    aoa.push([]);

    const rowTtd = (kiri, kanan) => {
        const r = Array(COL_LAST + 1).fill('');
        if (kiri  != null) r[0] = kiri;   // A — merge A:G
        if (kanan != null) r[8] = kanan;  // I — merge I:L
        return r;
    };

    if (pj) {
        aoa.push(rowTtd('Mengetahui,',      ''));
        aoa.push(rowTtd(``,  `Karawang, ${tglTtd}`));
        aoa.push(rowTtd('', ''));
        aoa.push(rowTtd('', ''));
        aoa.push(rowTtd('', ''));
        aoa.push(rowTtd('dr. Ucu Nurhadiat', pj.nama));
        aoa.push(rowTtd('Kepala Instalasi IT', pj.jabatan));
    } else {
        aoa.push(rowTtd(null, 'Mengetahui,'));
        aoa.push(rowTtd(null, `Karawang, ${tglTtd}`));
        aoa.push(rowTtd(null, ''));
        aoa.push(rowTtd(null, ''));
        aoa.push(rowTtd(null, ''));
        aoa.push(rowTtd(null, 'dr. Ucu Nurhadiat'));
        aoa.push(rowTtd(null, 'Kepala Instalasi IT'));
    }

    const ws = XLSX.utils.aoa_to_sheet(aoa);

    ws['!cols'] = [
        {wch: 5},  // A  No
        {wch:18},  // B  Ruangan
        {wch:20},  // C  Nama User
        {wch:16},  // D  Tgl Lapor
        {wch:16},  // E  Tgl Respon
        {wch:10},  // F  Durasi
        {wch:14},  // G  Divisi
        {wch:50},  // H  Masalah
        {wch:35},  // I  Solusi
        {wch:18},  // J  Petugas Dilaporkan
        {wch:18},  // K  Petugas Menyelesaikan
        {wch:12},  // L  Status
    ];

    const R_HEAD1 = 3, R_HEAD2 = 4;
    const R_DATA_START = 5;
    const R_DATA_END   = R_DATA_START + allData.length - 1;
    const R_TTD_START  = R_DATA_END + 3;

    ws['!merges'] = [
        { s:{r:0,c:0}, e:{r:0,c:COL_LAST} },
        { s:{r:1,c:0}, e:{r:1,c:COL_LAST} },
        // Merge vertikal untuk header yang tidak punya sub-kolom
        { s:{r:R_HEAD1,c:0}, e:{r:R_HEAD2,c:0} },   // No
        { s:{r:R_HEAD1,c:1}, e:{r:R_HEAD2,c:1} },   // Ruangan
        { s:{r:R_HEAD1,c:2}, e:{r:R_HEAD2,c:2} },   // Nama User
        { s:{r:R_HEAD1,c:3}, e:{r:R_HEAD2,c:3} },   // Tgl Lapor
        { s:{r:R_HEAD1,c:4}, e:{r:R_HEAD2,c:4} },   // Tgl Respon
        { s:{r:R_HEAD1,c:5}, e:{r:R_HEAD2,c:5} },   // Durasi
        { s:{r:R_HEAD1,c:6}, e:{r:R_HEAD2,c:6} },   // Divisi
        { s:{r:R_HEAD1,c:7}, e:{r:R_HEAD2,c:7} },   // Masalah
        { s:{r:R_HEAD1,c:8}, e:{r:R_HEAD2,c:8} },   // Solusi
        { s:{r:R_HEAD1,c:9}, e:{r:R_HEAD1,c:10} },  // "Petugas yang" — horizontal
        { s:{r:R_HEAD1,c:11}, e:{r:R_HEAD2,c:11} }, // Status
    ];

    for (let i = 0; i < 7; i++) {
        const r = R_TTD_START + i;
        ws['!merges'].push({ s:{r,c:0}, e:{r,c:6}         });
        ws['!merges'].push({ s:{r,c:8}, e:{r,c:COL_LAST}  });
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Laporan');

    const tglFile = new Date().toLocaleDateString('id-ID').replace(/\//g,'-');
    XLSX.writeFile(wb, `laporan_LAPOR_${tglFile}.xlsx`);
}
// ── Modal Lampiran ────────────────────────────────────────────────
function openLampiran(files) {
    hideAll(); pdfDoc = null; pdfPage = 1;
    const sidebar = document.getElementById('lmSidebar');
    sidebar.dataset.files = JSON.stringify(files);
    sidebar.innerHTML = files.map((fp, i) => {
        const name = fp.split('/').pop();
        return `<div class="lm-file-item${i===0?' active':''}" data-idx="${i}">
                    <span class="fi-icon">${fileIcon(fp)}</span>
                    <span class="fi-name">${h(name)}</span>
                    <span class="fi-num">${i+1}</span>
                </div>`;
    }).join('');
    bsModal.show();
    setTimeout(() => selectFile(0, files), 150);
}
function selectFile(idx, files) {
    document.querySelectorAll('#lmSidebar .lm-file-item').forEach((el,i) => el.classList.toggle('active', i===idx));
    const fp   = files[idx];
    // const url  = `http://${SERVER_IP}:3000/${fp}`;
    const url = `http://${SERVER_IP}:${WA_BOT_PORT}/${fp}`;
    const ext  = fp.split('.').pop().toLowerCase();
    const name = fp.split('/').pop();
    document.getElementById('lmFilename').textContent = name;
    const dl = document.getElementById('tbDownload');
    dl.href = url; dl.setAttribute('download', name);
    showLoading(true); hideAll();
    if (['jpg','jpeg','png','gif','webp'].includes(ext)) loadImage(url);
    else if (['mp4','3gp','mov','mkv','webm'].includes(ext)) loadVideo(url);
    else if (ext === 'pdf') loadPdf(url);
    else loadGeneric(url, name);
}
function loadImage(url) {
    imgScale = 1;
    const img = document.getElementById('imgViewer');
    img.onload  = () => { showLoading(false); img.style.display='block'; applyZoom(); };
    img.onerror = () => { showLoading(false); showErr('Gagal memuat gambar.'); };
    img.src = url; showTb('zoom');
}
function loadVideo(url) {
    const v = document.getElementById('videoViewer');
    v.src = url; v.style.display = 'block';
    v.oncanplay = () => showLoading(false);
    v.onerror   = () => { showLoading(false); showErr('Gagal memuat video.'); };
    showTb('none');
}
async function loadPdf(url) {
    showTb('pdf');
    try {
        pdfDoc = await pdfjsLib.getDocument(url).promise;
        pdfPage = 1; await renderPdfPage(); showLoading(false);
    } catch(e) { showLoading(false); showErr('Gagal memuat PDF: ' + e.message); }
}
async function renderPdfPage() {
    const wrap = document.getElementById('pdfWrapper');
    wrap.innerHTML = ''; wrap.style.display = 'flex';
    const page = await pdfDoc.getPage(pdfPage);
    const vp   = page.getViewport({ scale: 1.5 });
    const c    = document.createElement('canvas');
    c.width = vp.width; c.height = vp.height;
    wrap.appendChild(c);
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    document.getElementById('pdfPageInfo').textContent = `${pdfPage} / ${pdfDoc.numPages}`;
    document.getElementById('pdfPrev').disabled = pdfPage <= 1;
    document.getElementById('pdfNext').disabled = pdfPage >= pdfDoc.numPages;
}
function pdfPrevPage() { if (pdfPage>1) { pdfPage--; renderPdfPage(); } }
function pdfNextPage() { if (pdfDoc && pdfPage<pdfDoc.numPages) { pdfPage++; renderPdfPage(); } }
function loadGeneric(url, name) {
    showLoading(false);
    document.getElementById('fileViewerName').textContent = name;
    document.getElementById('fileViewerLink').href = url;
    document.getElementById('fileViewerLink').style.display = 'inline-block';
    document.getElementById('fileViewer').style.display = 'block';
    showTb('none');
}
function applyZoom() {
    document.getElementById('imgViewer').style.transform = `scale(${imgScale})`;
    document.getElementById('zoomVal').textContent = Math.round(imgScale*100)+'%';
}
function zoomIn()    { imgScale = Math.min(imgScale+0.25, 5);    applyZoom(); }
function zoomOut()   { imgScale = Math.max(imgScale-0.25, 0.25); applyZoom(); }
function zoomReset() { imgScale = 1; applyZoom(); }
function setupDrag() {
    const area = document.getElementById('lmViewArea');
    area.addEventListener('mousedown', e => {
        if (e.target.id !== 'imgViewer') return;
        imgDrag = true; dragX = e.clientX; dragY = e.clientY;
        scrollX = area.scrollLeft; scrollY = area.scrollTop;
        area.classList.add('grabbing');
    });
    window.addEventListener('mousemove', e => {
        if (!imgDrag) return;
        area.scrollLeft = scrollX - (e.clientX - dragX);
        area.scrollTop  = scrollY - (e.clientY - dragY);
    });
    window.addEventListener('mouseup', () => {
        imgDrag = false;
        document.getElementById('lmViewArea').classList.remove('grabbing');
    });
    area.addEventListener('wheel', e => {
        if (document.getElementById('imgViewer').style.display !== 'block') return;
        e.preventDefault();
        e.deltaY < 0 ? zoomIn() : zoomOut();
    }, { passive:false });
}
function hideAll() {
    ['imgViewer','videoViewer','pdfWrapper','fileViewer'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
    const v = document.getElementById('videoViewer');
    if (v) { v.pause(); v.src = ''; }
}
function showLoading(on) { document.getElementById('lmLoading').style.display = on ? 'flex':'none'; }
function showTb(type) {
    document.getElementById('tbZoom').style.display = type==='zoom' ? 'flex':'none';
    document.getElementById('tbPdf').style.display  = type==='pdf'  ? 'flex':'none';
}
function showErr(msg) {
    document.getElementById('fileViewer').style.display = 'block';
    document.getElementById('fileViewerName').textContent = msg;
    document.getElementById('fileViewerLink').style.display = 'none';
}
function fileIcon(fp) {
    const e = fp.split('.').pop().toLowerCase();
    if (['jpg','jpeg','png','gif','webp'].includes(e)) return '🖼️';
    if (['mp4','3gp','mov','mkv','webm'].includes(e))  return '🎥';
    if (e==='pdf') return '📄';
    if (['mp3','ogg','aac'].includes(e)) return '🎵';
    return '📎';
}
function h(s) {
    return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

document.getElementById('lampiranModal').addEventListener('hidden.bs.modal', () => {
    hideAll(); pdfDoc = null;
    document.getElementById('lmSidebar').innerHTML = '';
    document.getElementById('lmFilename').textContent = '—';
});

// ── Pagination ────────────────────────────────────────────────────
function renderPagination(total) {
    const ul = document.getElementById('pagination');
    if (total<=1) { ul.innerHTML=''; return; }
    let html='';
    html += `<li class="page-item ${currentPage===1?'disabled':''}"><a class="page-link" onclick="renderPage(${currentPage-1})">‹ Prev</a></li>`;
    let s=Math.max(1,currentPage-2), e=Math.min(total,s+4); s=Math.max(1,e-4);
    if (s>1) { html+=`<li class="page-item"><a class="page-link" onclick="renderPage(1)">1</a></li>`; if(s>2) html+=`<li class="page-item disabled"><a class="page-link">…</a></li>`; }
    for(let p=s;p<=e;p++) html+=`<li class="page-item ${p===currentPage?'active':''}"><a class="page-link" onclick="renderPage(${p})">${p}</a></li>`;
    if (e<total) { if(e<total-1) html+=`<li class="page-item disabled"><a class="page-link">…</a></li>`; html+=`<li class="page-item"><a class="page-link" onclick="renderPage(${total})">${total}</a></li>`; }
    html += `<li class="page-item ${currentPage===total?'disabled':''}"><a class="page-link" onclick="renderPage(${currentPage+1})">Next ›</a></li>`;
    ul.innerHTML = html;
}

// ── Helper: parse response JSON dengan aman ─────────────────────
async function safeJson(response) {
    const text = await response.text();
    try { return JSON.parse(text); }
    catch(e) { throw new Error('Server error: ' + text.substring(0, 300)); }
}

// ── Per-page selector ─────────────────────────────────────────────
function ubahPerPage(val) {
    PER_PAGE    = parseInt(val);
    currentPage = 1;
    renderPage(1);
}

// ── Modal Tambah Data Manual ──────────────────────────────────────
let bsTambahModal, bsSelesaiModal;
let selesaiTarget = { id: null, nomor: null };

function openTambahModal() {
    if (!bsTambahModal) bsTambahModal = new bootstrap.Modal(document.getElementById('tambahModal'));
    // Isi dropdown divisi
    const sel = document.getElementById('tm_divisi');
    while (sel.options.length > 1) sel.remove(1);
    allDivisi.forEach(d => sel.add(new Option(d.name, d.kd_divisi)));
    // Reset fields
    ['tm_nama','tm_nomor','tm_unit','tm_isi','tm_operator'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('tm_divisi').value = '';
    // Reset lampiran
    const inputFile = document.getElementById('tm_lampiran');
    if (inputFile) { inputFile.value = ''; }
    const prev = document.getElementById('tm_lampiran_preview');
    if (prev) prev.innerHTML = '';
    bsTambahModal.show();
}

// Preview nama file yang dipilih
document.addEventListener('DOMContentLoaded', () => {
    const inp = document.getElementById('tm_lampiran');
    if (inp) {
        inp.addEventListener('change', () => {
            const prev = document.getElementById('tm_lampiran_preview');
            if (!prev) return;
            if (inp.files.length === 0) { prev.innerHTML = ''; return; }
            const names = Array.from(inp.files).map((f, i) =>
                `<span style="display:inline-block;margin-right:6px;">📎 ${i+1}. ${f.name}</span>`
            ).join('<br>');
            prev.innerHTML = names;
        });
    }
});

async function simpanTambahLaporan() {
    const isi = document.getElementById('tm_isi').value.trim();
    if (!isi) { alert('Isi laporan wajib diisi.'); return; }

    const btn = document.querySelector('#tambahModal .btn-primary');
    btn.disabled = true; btn.textContent = '⏳ Menyimpan...';

    try {
        // Gunakan FormData agar bisa kirim file lampiran (multipart)
        const fd = new FormData();
        fd.append('nama',      document.getElementById('tm_nama').value.trim());
        fd.append('nomor',     document.getElementById('tm_nomor').value.trim());
        fd.append('unit',      document.getElementById('tm_unit').value.trim());
        fd.append('kd_divisi', document.getElementById('tm_divisi').value || '');
        fd.append('isi_pesan', isi);
        fd.append('operator',  document.getElementById('tm_operator').value.trim() || 'Admin');

        // Tambahkan semua file lampiran (bisa > 1)
        const inputFile = document.getElementById('tm_lampiran');
        if (inputFile && inputFile.files.length > 0) {
            Array.from(inputFile.files).forEach(f => fd.append('lampiran', f));
        }

        const res = await fetch(`http://${SERVER_IP}:${WA_BOT_PORT}/tambah-laporan`, {
            method : 'POST',
            // JANGAN set Content-Type — browser otomatis set multipart/form-data dengan boundary
            body   : fd
        });
        const r = await safeJson(res);
        if (r.success) {
            const info = r.lampiran > 0 ? ` dengan ${r.lampiran} lampiran` : '';
            alert(`✅ Laporan #${r.id} berhasil ditambahkan${info} & notifikasi terkirim ke grup WA.`);
            bsTambahModal.hide();
            await loadData();
        } else {
            alert('❌ Gagal: ' + (r.error || 'Unknown error'));
        }
    } catch(e) {
        alert('❌ ' + e.message);
    } finally {
        btn.disabled = false; btn.textContent = '💾 Simpan & Kirim Notif';
    }
}

// ── Proses langsung (tanpa modal) ────────────────────────────────
async function updateStatusProses(id, nomor, nama) {
    if (!confirm(`Tandai laporan #${id} (${nama}) sebagai DIPROSES?
Notifikasi akan dikirim ke pelapor.`)) return;
    try {
        const res = await fetch(`http://${SERVER_IP}:${WA_BOT_PORT}/update-status`, {
            method : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body   : JSON.stringify({ id, nomor, status: 1, operator: 'Operator Dashboard' })
        });
        const r = await safeJson(res);
        if (r.success) { await loadData(); }
        else alert('Gagal update: ' + r.error);
    } catch(e) { alert('Gagal: ' + e.message); }
}

// ── Selesaikan via modal (ada input solusi) ───────────────────────
function bukaModalSelesai(id, nama, nomor) {
    if (!bsSelesaiModal) bsSelesaiModal = new bootstrap.Modal(document.getElementById('selesaiModal'));
    selesaiTarget = { id, nomor };
    document.getElementById('sl_id').textContent   = '#' + id;
    document.getElementById('sl_nama').textContent = nama;
    document.getElementById('sl_solusi').value   = '';
    document.getElementById('sl_operator').value = '';
    bsSelesaiModal.show();
}

async function konfirmasiSelesai() {
    const { id, nomor } = selesaiTarget;
    const solusi   = document.getElementById('sl_solusi').value.trim();
    const operator = document.getElementById('sl_operator').value.trim() || 'Operator Dashboard';

    const btn = document.querySelector('#selesaiModal .btn-success');
    btn.disabled = true; btn.textContent = '⏳ Mengirim...';

    try {
        const res = await fetch(`http://${SERVER_IP}:${WA_BOT_PORT}/update-status`, {
            method : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body   : JSON.stringify({ id, nomor, status: 2, operator, solusi })
        });
        const r = await safeJson(res);
        if (r.success) {
            bsSelesaiModal.hide();
            await loadData();
        } else {
            alert('Gagal: ' + r.error);
        }
    } catch(e) {
        alert('Gagal: ' + e.message);
    } finally {
        btn.disabled = false; btn.textContent = '✅ Selesaikan & Kirim Notif';
    }
}

let bsUpModal;
let upTarget = { id: null, nomor: null };

function bukaModalUp(id, nama, nomor) {
    if (!bsUpModal) bsUpModal = new bootstrap.Modal(document.getElementById('upModal'));
    upTarget = { id, nomor };
    document.getElementById('up_id').textContent   = '#' + id;
    document.getElementById('up_nama').textContent = nama;
    document.getElementById('up_alasan').value   = '';
    document.getElementById('up_operator').value = '';
    bsUpModal.show();
}

async function konfirmasiUp() {
    const { id, nomor } = upTarget;
    const alasan   = document.getElementById('up_alasan').value.trim();
    const operator = document.getElementById('up_operator').value.trim() || 'Operator Dashboard';
    if (!alasan) { alert('Alasan wajib diisi.'); return; }

    const btn = document.querySelector('#upModal .btn-danger');
    btn.disabled = true; btn.textContent = '⏳ Mengirim...';
    try {
        const res = await fetch(`http://${SERVER_IP}:${WA_BOT_PORT}/update-status`, {
            method : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body   : JSON.stringify({ id, nomor, status: 3, operator, solusi: alasan })
        });
        const r = await safeJson(res);
        if (r.success) { bsUpModal.hide(); await loadData(); }
        else alert('Gagal: ' + r.error);
    } catch(e) { alert('Gagal: ' + e.message); }
    finally { btn.disabled = false; btn.textContent = '🔴 Tandai & Kirim Notif'; }
}

// ── Update status (legacy, masih dipakai referensi internal) ─────
async function updateStatus(id, nomor, targetStatus) {
    if (targetStatus === 1) { await updateStatusProses(id, nomor, 'Laporan #' + id); return; }
    if (targetStatus === 2) { bukaModalSelesai(id, 'Laporan #' + id, nomor); return; }
}

// ================================================================
// FILTER PETUGAS — populasi dropdown dari data yang ada
// ================================================================


// ================================================================
// GRAFIK ANALITIK
// ================================================================
let grafikMode   = 'general'; // 'general' atau 'spesifik'
let chartBarInst = null;
let chartPieInst = null;
let bsGrafikModal;
let keywordDivisiData = []; // cache keyword_divisi dari server

// Warna palette
const PALETTE = [
    '#4361ee','#3a0ca3','#7209b7','#f72585','#4cc9f0',
    '#fb8500','#06d6a0','#ef233c','#8338ec','#023e8a',
    '#2ec4b6','#e9c46a','#f4a261','#e76f51','#264653'
];

async function openGrafik() {
    if (!bsGrafikModal) bsGrafikModal = new bootstrap.Modal(document.getElementById('grafikModal'));

    // Isi dropdown divisi filter (untuk mode spesifik)
    const selDiv = document.getElementById('grafikDivisiFilter');
    while (selDiv.options.length > 1) selDiv.remove(1);
    allDivisi.forEach(d => selDiv.add(new Option(d.name, d.kd_divisi)));

    // Load keyword_divisi dari server via PHP
    try {
        const res  = await fetch('get_messages.php?action=keywords');
        const json = await res.json();
        keywordDivisiData = json.keywords || [];
    } catch(e) { keywordDivisiData = []; }

    bsGrafikModal.show();
    setTimeout(() => {
        switchGrafik('general');
    }, 200);
}

function switchGrafik(mode) {
    grafikMode = mode;
    document.getElementById('btnGeneral').style.cssText   = mode==='general'   ? 'background:#6f42c1;color:#fff;border-color:#6f42c1;' : '';
    document.getElementById('btnSpesifik').style.cssText  = mode==='spesifik'  ? 'background:#6f42c1;color:#fff;border-color:#6f42c1;' : '';
    document.getElementById('btnGeneral').className   = 'btn btn-sm ' + (mode==='general'  ? '' : 'btn-outline-secondary');
    document.getElementById('btnSpesifik').className  = 'btn btn-sm ' + (mode==='spesifik' ? '' : 'btn-outline-secondary');
    document.getElementById('filterSpesifikWrap').style.display = mode==='spesifik' ? 'flex' : 'none';

    if (mode === 'general') renderGrafikGeneral();
    else                    renderGrafikSpesifik();
}

function destroyCharts() {
    if (chartBarInst) { chartBarInst.destroy(); chartBarInst = null; }
    if (chartPieInst) { chartPieInst.destroy(); chartPieInst = null; }
}

// ── Mode GENERAL: per Divisi ──────────────────────────────────────
function renderGrafikGeneral() {
    destroyCharts();
    document.getElementById('chartBarTitle').textContent = 'Jumlah Laporan per Divisi';
    document.getElementById('chartPieTitle').textContent = 'Proporsi per Divisi';

    const map = {};
    map['__none__'] = { nama: 'Tidak Terdeteksi', total: 0, open: 0, proses: 0, selesai: 0, up: 0 };

    allData.forEach(d => {
        const key  = d.kd_divisi || '__none__';
        const nama = d.nama_divisi || 'Tidak Terdeteksi';
        if (!map[key]) map[key] = { nama, total: 0, open: 0, proses: 0, selesai: 0, up: 0 };
        map[key].total++;
        const st = parseInt(d.status_selesai) || 0;
        if (st === 0)      map[key].open++;
        else if (st === 1) map[key].proses++;
        else if (st === 3) map[key].up++;      // ⬅️ baru
        else               map[key].selesai++;
    });

    const entries = Object.values(map).filter(e => e.total > 0).sort((a, b) => b.total - a.total);
    const total   = entries.reduce((s, e) => s + e.total, 0);
    const labels  = entries.map(e => e.nama);
    const data    = entries.map(e => e.total);
    const colors  = entries.map((_, i) => PALETTE[i % PALETTE.length]);

    document.getElementById('grafikSubtitle').textContent =
        `Total: ${total} laporan · ${entries.length} divisi`;

    if (!entries.length) {
        document.getElementById('grafikTabelBody').innerHTML =
            '<tr><td colspan="7" class="text-center text-muted py-3">Tidak ada data.</td></tr>';
        return;
    }

    // Bar chart
    chartBarInst = new Chart(document.getElementById('chartBar'), {
        type: 'bar',
        data: {
            labels,
            datasets: [{ label: 'Jumlah Laporan', data, backgroundColor: colors, borderRadius: 6 }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                y: { beginAtZero: true, ticks: { stepSize: 1 } },
                x: { ticks: { font: { size: 10 } } }
            }
        }
    });

    // Doughnut chart
    chartPieInst = new Chart(document.getElementById('chartPie'), {
        type: 'doughnut',
        data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 2 }] },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { position: 'right', labels: { font: { size: 11 }, boxWidth: 14 } },
                tooltip: {
                    callbacks: {
                        label: ctx => ` ${ctx.label}: ${ctx.raw} (${total > 0 ? ((ctx.raw/total)*100).toFixed(1) : 0}%)`
                    }
                }
            }
        }
    });

    document.getElementById('grafikTabelBody').innerHTML = entries.map((e, i) => `
        <tr>
            <td>
                <span style="display:inline-block;width:10px;height:10px;border-radius:50%;
                    background:${colors[i]};margin-right:6px;"></span>
                ${h(e.nama)}
            </td>
            <td class="text-center"><strong>${e.total}</strong></td>
            <td class="text-center">${((e.total/total)*100).toFixed(1)}%</td>
            <td class="text-center"><span class="badge bg-warning text-dark">${e.open}</span></td>
            <td class="text-center"><span class="badge bg-primary">${e.proses}</span></td>
            <td class="text-center"><span class="badge bg-success">${e.selesai}</span></td>
            <td class="text-center"><span class="badge bg-danger">${e.up}</span></td>   <!-- ⬅️ kolom baru -->
        </tr>`).join('') || '<tr><td colspan="7" class="text-center text-muted">Tidak ada data</td></tr>';
}

// ── Mode SPESIFIK: per Keyword dalam divisi tertentu ──────────────
function renderGrafikSpesifik() {
    destroyCharts();
    const kdDivisi = document.getElementById('grafikDivisiFilter').value;
    document.getElementById('chartBarTitle').textContent = 'Jumlah Laporan per Kategori';
    document.getElementById('chartPieTitle').textContent = 'Proporsi per Kategori';

    let dataFiltered = allData;
    if (kdDivisi) dataFiltered = dataFiltered.filter(d => String(d.kd_divisi) === String(kdDivisi));

    const map = {};
    map['__none__'] = { nama: 'Tidak Terkategori', total: 0, open: 0, proses: 0, selesai: 0, up: 0 };

    dataFiltered.forEach(d => {
        const key  = d.kd_mapping_divisi || '__none__';
        const nama = d.nama_mapping || 'Tidak Terkategori';
        if (!map[key]) map[key] = { nama, total: 0, open: 0, proses: 0, selesai: 0, up: 0 };
        map[key].total++;
        const st = parseInt(d.status_selesai) || 0;
        if (st === 0)      map[key].open++;
        else if (st === 1) map[key].proses++;
        else if (st === 3) map[key].up++;
        else               map[key].selesai++;
    });

    const entries = Object.values(map).filter(e => e.total > 0).sort((a, b) => b.total - a.total);
    const total   = entries.reduce((s, e) => s + e.total, 0);
    const labels  = entries.map(e => e.nama);
    const data    = entries.map(e => e.total);
    const colors  = entries.map((_, i) => PALETTE[i % PALETTE.length]);

    const divisiNama = kdDivisi
        ? (allDivisi.find(d => String(d.kd_divisi) === String(kdDivisi))?.name || 'Divisi')
        : 'Semua Divisi';
    document.getElementById('grafikSubtitle').textContent =
        `${divisiNama} · ${entries.length} kategori · Total: ${total}`;

    if (!entries.length) {
        document.getElementById('grafikTabelBody').innerHTML =
            '<tr><td colspan="7" class="text-center text-muted py-3">Tidak ada kategori pada data laporan saat ini.</td></tr>';
        return;
    }

    chartBarInst = new Chart(document.getElementById('chartBar'), {
        type: 'bar',
        data: { labels, datasets: [{ label: 'Jumlah Laporan', data, backgroundColor: colors, borderRadius: 6 }] },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } }, x: { ticks: { font: { size: 10 } } } }
        }
    });

    chartPieInst = new Chart(document.getElementById('chartPie'), {
        type: 'doughnut',
        data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 2 }] },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { position: 'right', labels: { font: { size: 11 }, boxWidth: 14 } },
                tooltip: {
                    callbacks: {
                        label: ctx => ` ${ctx.label}: ${ctx.raw} (${total > 0 ? ((ctx.raw/total)*100).toFixed(1) : 0}%)`
                    }
                }
            }
        }
    });

    document.getElementById('grafikTabelBody').innerHTML = entries.map((e, i) => `
        <tr>
            <td>
                <span style="display:inline-block;width:10px;height:10px;border-radius:50%;
                    background:${colors[i]};margin-right:6px;"></span>
                <strong>${h(e.nama)}</strong>
            </td>
            <td class="text-center"><strong>${e.total}</strong></td>
            <td class="text-center">${total > 0 ? ((e.total/total)*100).toFixed(1) : 0}%</td>
            <td class="text-center"><span class="badge bg-warning text-dark">${e.open}</span></td>
            <td class="text-center"><span class="badge bg-primary">${e.proses}</span></td>
            <td class="text-center"><span class="badge bg-success">${e.selesai}</span></td>
            <td class="text-center"><span class="badge bg-danger">${e.up}</span></td>
        </tr>`).join('');
}

// Reset grafik saat modal ditutup
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('grafikModal')?.addEventListener('hidden.bs.modal', destroyCharts);
});


// async function kirimSpreadsheet() {
//     if (!allData.length) { alert('Tidak ada data untuk dikirim.'); return; }
//     if (!confirm(`Kirim ${allData.length} laporan ke Google Spreadsheet?`)) return;

//     try {
//         const res = await fetch(`http://${SERVER_IP}:${WA_BOT_PORT}/kirim-spreadsheet`, {
//             method: 'POST',
//             headers: { 'Content-Type': 'application/json' },
//             body: JSON.stringify({ data: allData })
//         });
//         const r = await res.json();
//         if (r.success) alert(`✅ ${r.jumlah} laporan berhasil dikirim ke spreadsheet.`);
//         else alert('❌ Gagal: ' + r.error);
//     } catch (e) {
//         alert('❌ Gagal kirim: ' + e.message);
//     }
// }

let bsSheetModal;

function kirimSpreadsheet() {
    if (!allData.length) { alert('Tidak ada data untuk dikirim.'); return; }
    if (!bsSheetModal) bsSheetModal = new bootstrap.Modal(document.getElementById('sheetModal'));

    // Default nama sheet: bulan-tahun sekarang, misal "agustus-2026"
    const bulanNama = new Date().toLocaleDateString('id-ID', { month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' })
        .toLowerCase().replace(' ', '-');
    document.getElementById('sheet_nama').value = bulanNama;
    document.getElementById('sheet_total_data').textContent = allData.length;

    bsSheetModal.show();
}

async function konfirmasiKirimSpreadsheet() {
    const namaSheet = document.getElementById('sheet_nama').value.trim();
    if (!namaSheet) { alert('Nama sheet wajib diisi.'); return; }

    const btn = document.querySelector('#sheetModal .btn-primary');
    btn.disabled = true; btn.textContent = '⏳ Mengirim...';

    try {
        const res = await fetch(`http://${SERVER_IP}:${WA_BOT_PORT}/kirim-spreadsheet`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: allData, sheet_name: namaSheet })
        });
        const r = await safeJson(res);
        if (r.success) {
            bsSheetModal.hide();
            const info = r.sheet_baru_dibuat ? ` (tab baru "${r.sheet}" dibuat)` : ` (tab "${r.sheet}")`;
            alert(`✅ ${r.jumlah} laporan berhasil dikirim ke spreadsheet${info}.`);
        } else {
            alert('❌ Gagal: ' + r.error);
        }
    } catch (e) {
        alert('❌ Gagal kirim: ' + e.message);
    } finally {
        btn.disabled = false; btn.textContent = '📤 Kirim';
    }
}


let wakeLock = null;

async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            console.log('✅ Wake Lock aktif — layar tidak akan mati');
            wakeLock.addEventListener('release', () => {
                console.log('🔓 Wake Lock dilepas, mencoba minta ulang...');
            });
        } else {
            console.log('⚠️ Wake Lock API tidak didukung browser ini');
        }
    } catch (err) {
        console.error('Gagal request wake lock:', err);
    }
}

requestWakeLock();

document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
        await requestWakeLock();
    }
});

setInterval(() => {
    document.dispatchEvent(new Event('mousemove'));
    document.dispatchEvent(new Event('touchstart'));
    document.dispatchEvent(new Event('keydown'));
}, 30000); // tiap 5 detik
</script>
</body>
</html>