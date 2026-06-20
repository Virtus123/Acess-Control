/**
 * Gera PDF simples com distribuição de vagas por empresa.
 *
 * Uso:
 *   node src/scripts/export-parking-vagas-pdf.mjs haofices
 *   node src/scripts/export-parking-vagas-pdf.mjs haofices --out C:\temp\vagas.pdf
 */

import fs from 'fs';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import PDFDocument from 'pdfkit';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const tenantId = args.find(a => !a.startsWith('--')) || 'haofices';
const outIdx = args.indexOf('--out');
const customOut = outIdx >= 0 ? args[outIdx + 1] : null;

const dbPath = join(__dirname, '..', '..', 'database', 'tenants', `tenant_${tenantId}.db`);
const db = new Database(dbPath, { readonly: true });

const parking = db.prepare('SELECT id, name, type, total_spots, empresas FROM parkings WHERE id = 1').get();
if (!parking) {
  console.error('Estacionamento não encontrado');
  process.exit(1);
}

let empresas = [];
try {
  empresas = JSON.parse(parking.empresas || '[]');
} catch {
  console.error('JSON empresas inválido');
  process.exit(1);
}

const rows = empresas.map(e => {
  const c = db.prepare('SELECT corporate_name, trading_name FROM companies WHERE id = ?').get(e.empresaId);
  const nome = (c?.trading_name || c?.corporate_name || `Empresa #${e.empresaId}`).trim();
  return { nome, vagas: Number(e.vagas) || 0 };
});

rows.sort((a, b) => b.vagas - a.vagas || a.nome.localeCompare(b.nome, 'pt-BR'));
const totalAlocado = rows.reduce((s, r) => s + r.vagas, 0);
const dataGeracao = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

db.close();

const reportsDir = join(__dirname, '..', '..', 'reports');
mkdirSync(reportsDir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);
const outPath = customOut || join(reportsDir, `distribuicao-vagas-${tenantId}-${stamp}.pdf`);

const doc = new PDFDocument({ size: 'A4', margin: 50 });
const stream = fs.createWriteStream(outPath);
doc.pipe(stream);

doc.fontSize(18).font('Helvetica-Bold').text('Distribuição de Vagas — Estacionamento', { align: 'center' });
doc.moveDown(0.5);
doc.fontSize(12).font('Helvetica').text(`Tenant: ${tenantId}`, { align: 'center' });
doc.moveDown(1);

doc.fontSize(11).font('Helvetica-Bold').text('Resumo', { underline: true });
doc.moveDown(0.4);
doc.font('Helvetica').fontSize(10);
doc.text(`Pátio: ${parking.name}`);
doc.text(`Tipo: ${parking.type}`);
doc.text(`Capacidade total: ${parking.total_spots} vagas`);
doc.text(`Soma alocada (empresas): ${totalAlocado} vagas`);
doc.text(`Empresas com cota: ${rows.length}`);
doc.text(`Gerado em: ${dataGeracao}`);
doc.moveDown(1);

doc.fontSize(11).font('Helvetica-Bold').text('Empresa — Vagas alocadas', { underline: true });
doc.moveDown(0.5);

const colEmpresa = 50;
const colVagas = 500;
const lineH = 14;
let y = doc.y;

doc.fontSize(9).font('Helvetica-Bold');
doc.text('Empresa', colEmpresa, y, { width: 440 });
doc.text('Vagas', colVagas, y, { width: 45, align: 'right' });
y += lineH;
doc.moveTo(50, y).lineTo(545, y).stroke();
y += 6;

doc.font('Helvetica').fontSize(8.5);

for (const r of rows) {
  if (y > 760) {
    doc.addPage();
    y = 50;
    doc.fontSize(9).font('Helvetica-Bold');
    doc.text('Empresa', colEmpresa, y, { width: 440 });
    doc.text('Vagas', colVagas, y, { width: 45, align: 'right' });
    y += lineH;
    doc.moveTo(50, y).lineTo(545, y).stroke();
    y += 6;
    doc.font('Helvetica').fontSize(8.5);
  }

  doc.text(r.nome, colEmpresa, y, { width: 440, lineBreak: false });
  doc.text(String(r.vagas), colVagas, y, { width: 45, align: 'right', lineBreak: false });
  y += lineH;
}

doc.end();

stream.on('finish', () => {
  console.log('PDF gerado:', outPath);
});

stream.on('error', err => {
  console.error(err);
  process.exit(1);
});
