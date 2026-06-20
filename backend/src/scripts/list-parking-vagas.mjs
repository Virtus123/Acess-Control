import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const tenantId = process.argv[2] || 'haofices';
const dbPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'database', 'tenants', `tenant_${tenantId}.db`);
const db = new Database(dbPath, { readonly: true });

const parking = db.prepare('SELECT id, name, type, total_spots, empresas FROM parkings WHERE id = 1').get();
if (!parking) {
  console.error('Estacionamento id=1 não encontrado');
  process.exit(1);
}

let empresas = [];
try {
  empresas = JSON.parse(parking.empresas || '[]');
} catch {
  console.error('JSON empresas inválido');
  process.exit(1);
}

const totalAlocado = empresas.reduce((s, e) => s + (Number(e.vagas) || 0), 0);

const rows = empresas.map(e => {
  const c = db.prepare('SELECT corporate_name, trading_name FROM companies WHERE id = ?').get(e.empresaId);
  const ocupados = db.prepare(
    "SELECT COUNT(*) as n FROM vehicles WHERE status = 'active' AND parking_id = 1 AND company_id = ?"
  ).get(e.empresaId)?.n ?? 0;
  const nome = (c?.trading_name || c?.corporate_name || `Empresa #${e.empresaId}`).trim();
  return { id: e.empresaId, nome, vagas: Number(e.vagas) || 0, ocupados };
});

rows.sort((a, b) => b.vagas - a.vagas || a.nome.localeCompare(b.nome, 'pt-BR'));

console.log(`Pátio: ${parking.name}`);
console.log(`Tipo: ${parking.type} | Capacidade total: ${parking.total_spots} | Soma alocada (JSON): ${totalAlocado}`);
console.log(`Empresas: ${rows.length}\n`);

for (const r of rows) {
  const uso = r.ocupados > 0 ? ` — ${r.ocupados} veículo(s) no pátio agora` : '';
  const alerta = r.ocupados > r.vagas ? ' ⚠️ acima da cota' : '';
  console.log(`${r.nome}: ${r.vagas} vaga${r.vagas !== 1 ? 's' : ''}${uso}${alerta}`);
}

db.close();
