import { LoadTestRunRecord } from './types';

// Gera um relatório em PDF de uma run de load test (ao vivo ou do histórico)
// e salva num arquivo escolhido pelo usuário. Mesmo padrão de diálogo que
// exportLoadTestRecord (JSON) em loadTestHistory.ts, só que grava binário
// (writeFile) em vez de texto.

const ACCENT: [number, number, number] = [9, 123, 237]; // #097bed
const GREEN: [number, number, number] = [79, 194, 132];
const RED: [number, number, number] = [230, 90, 90];
const GRAY: [number, number, number] = [110, 110, 110];
const DARK: [number, number, number] = [30, 30, 30];

function formatMs(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return v < 10 ? v.toFixed(2) : Math.round(v).toString();
}

function modeLabel(record: LoadTestRunRecord): string {
  if (record.mode === 'ramp') {
    const stages = record.config.stages ?? [];
    const total = stages.reduce((acc, s) => acc + (s.durationSecs || 0), 0);
    return `Ramp · ${stages.length} stage${stages.length === 1 ? '' : 's'} · ${total}s total`;
  }
  if (record.mode === 'iterations') {
    return `${record.config.vus ?? '?'} VUs · ${record.config.iterationsPerVu ?? '?'} iterations/VU`;
  }
  return `${record.config.vus ?? '?'} VUs · ${record.config.durationSecs ?? '?'}s`;
}

export async function exportLoadTestRecordAsPdf(record: LoadTestRunRecord): Promise<void> {
  const { default: jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const { save } = await import('@tauri-apps/plugin-dialog');
  const { writeFile } = await import('@tauri-apps/plugin-fs');

  const s = record.summary;
  const errorRate = s.requestsTotal > 0 ? (s.requestsFailed / s.requestsTotal) * 100 : 0;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const marginX = 40;
  const pageWidth = doc.internal.pageSize.getWidth();
  let y = 50;

  // ── Header ────────────────────────────────────────────────────────────
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(...DARK);
  doc.text('Load Test Report', marginX, y);
  y += 22;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(...GRAY);
  doc.text(record.itemName, marginX, y);
  y += 16;

  doc.setFontSize(9);
  doc.text(`Run started: ${new Date(record.startedAt).toLocaleString()}`, marginX, y);
  y += 13;
  doc.text(`Config: ${modeLabel(record)}`, marginX, y);
  y += 13;
  const envVarCount = Object.keys(record.config.environment || {}).length;
  doc.text(
    `Flow: ${record.config.flow.length} request${record.config.flow.length === 1 ? '' : 's'} · Environment: ${envVarCount} variable${envVarCount === 1 ? '' : 's'}`,
    marginX,
    y
  );
  y += 20;

  doc.setDrawColor(220, 220, 220);
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 20;

  // ── Summary stat cards (drawn as a simple table row) ────────────────────
  autoTable(doc, {
    startY: y,
    margin: { left: marginX, right: marginX },
    head: [['Requests', 'RPS (avg)', 'Error rate', 'Script errors']],
    body: [[
      s.requestsTotal.toLocaleString(),
      s.rpsAvg.toFixed(1),
      `${errorRate.toFixed(1)}%`,
      String(s.scriptErrors),
    ]],
    theme: 'grid',
    headStyles: { fillColor: ACCENT, textColor: 255, fontSize: 9 },
    bodyStyles: { fontSize: 11, halign: 'center', textColor: DARK },
    styles: { cellPadding: 8 },
  });
  // @ts-expect-error — jspdf-autotable anexa lastAutoTable no doc em runtime
  y = doc.lastAutoTable.finalY + 24;

  // ── Latency table ────────────────────────────────────────────────────
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...DARK);
  doc.text('Latency (ms)', marginX, y);
  y += 8;

  autoTable(doc, {
    startY: y,
    margin: { left: marginX, right: marginX },
    head: [['min', 'avg', 'p50', 'p90', 'p95', 'p99', 'max']],
    body: [[
      formatMs(s.latencyMinMs),
      formatMs(s.latencyAvgMs),
      formatMs(s.latencyP50Ms),
      formatMs(s.latencyP90Ms),
      formatMs(s.latencyP95Ms),
      formatMs(s.latencyP99Ms),
      formatMs(s.latencyMaxMs),
    ]],
    theme: 'grid',
    headStyles: { fillColor: [40, 40, 40], textColor: 255, fontSize: 9 },
    bodyStyles: { fontSize: 10, halign: 'center', textColor: DARK },
  });
  // @ts-expect-error -- jspdf-autotable anexa lastAutoTable no doc em runtime
  y = doc.lastAutoTable.finalY + 24;

  // ── Thresholds ───────────────────────────────────────────────────────
  if (s.thresholdResults.length > 0) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...DARK);
    doc.text('Thresholds', marginX, y);
    y += 8;

    autoTable(doc, {
      startY: y,
      margin: { left: marginX, right: marginX },
      head: [['Metric', 'Condition', 'Actual', 'Result']],
      body: s.thresholdResults.map(t => [
        t.metric,
        `${t.operator} ${t.value}`,
        formatMs(t.actual),
        t.passed ? 'PASS' : 'FAIL',
      ]),
      theme: 'grid',
      headStyles: { fillColor: [40, 40, 40], textColor: 255, fontSize: 9 },
      bodyStyles: { fontSize: 10, textColor: DARK },
      didParseCell: (data: any) => {
        if (data.section === 'body' && data.column.index === 3) {
          const passed = data.cell.raw === 'PASS';
          data.cell.styles.textColor = passed ? GREEN : RED;
          data.cell.styles.fontStyle = 'bold';
        }
      },
    });
    // @ts-expect-error -- jspdf-autotable anexa lastAutoTable no doc em runtime
    y = doc.lastAutoTable.finalY + 24;
  }

  // ── Status codes ─────────────────────────────────────────────────────
  const statusEntries = Object.entries(s.statusCodes).sort((a, b) => b[1] - a[1]);
  if (statusEntries.length > 0) {
    if (y > doc.internal.pageSize.getHeight() - 150) {
      doc.addPage();
      y = 50;
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...DARK);
    doc.text('Status codes', marginX, y);
    y += 8;

    autoTable(doc, {
      startY: y,
      margin: { left: marginX, right: marginX },
      head: [['Code', 'Count', '% of total']],
      body: statusEntries.map(([code, count]) => [
        code,
        count.toLocaleString(),
        s.requestsTotal > 0 ? `${((count / s.requestsTotal) * 100).toFixed(1)}%` : '—',
      ]),
      theme: 'grid',
      headStyles: { fillColor: [40, 40, 40], textColor: 255, fontSize: 9 },
      bodyStyles: { fontSize: 10, textColor: DARK },
      didParseCell: (data: any) => {
        if (data.section === 'body' && data.column.index === 0) {
          const code = String(data.cell.raw);
          data.cell.styles.textColor = code === 'error' || code.startsWith('5') || code.startsWith('4')
            ? RED
            : GREEN;
          data.cell.styles.fontStyle = 'bold';
        }
      },
    });
    // @ts-expect-error -- jspdf-autotable anexa lastAutoTable no doc em runtime
    y = doc.lastAutoTable.finalY + 24;
  }

  // ── Flow requests ────────────────────────────────────────────────────
  if (y > doc.internal.pageSize.getHeight() - 150) {
    doc.addPage();
    y = 50;
  }
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...DARK);
  doc.text('Request flow', marginX, y);
  y += 8;

  autoTable(doc, {
    startY: y,
    margin: { left: marginX, right: marginX },
    head: [['#', 'Method', 'URL']],
    body: record.config.flow.map((step, i) => [String(i + 1), step.method, step.url]),
    theme: 'grid',
    headStyles: { fillColor: [40, 40, 40], textColor: 255, fontSize: 9 },
    bodyStyles: { fontSize: 9, textColor: DARK },
    columnStyles: { 0: { cellWidth: 24 }, 1: { cellWidth: 60 } },
  });

  // ── Footer on every page ─────────────────────────────────────────────
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...GRAY);
    doc.text(
      `Generated by DevFlow · ${new Date().toLocaleString()}`,
      marginX,
      doc.internal.pageSize.getHeight() - 20
    );
    doc.text(
      `Page ${i} of ${pageCount}`,
      pageWidth - marginX,
      doc.internal.pageSize.getHeight() - 20,
      { align: 'right' }
    );
  }

  const safeName = record.itemName.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'load-test';
  const dateStamp = record.startedAt.slice(0, 19).replace(/[:T]/g, '-');

  const filePath = await save({
    defaultPath: `${safeName}_${dateStamp}.pdf`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (!filePath) return;

  const bytes = new Uint8Array(doc.output('arraybuffer'));
  await writeFile(filePath, bytes);
}
