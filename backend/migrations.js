/**
 * Script de Migração Standalone
 * Executa todas as migrações do banco de dados
 * 
 * Uso: node migrations.js [tenant_id]
 * Exemplo: node migrations.js mamsolucoes
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sqlite3 from 'sqlite3';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATIONS_DIR = path.join(__dirname, 'src', 'database', 'migrations');
const TENANTS_DIR = process.env.DATABASE_STORAGE || path.join(__dirname, 'database', 'tenants');

function getTenantDbPath(tenantId) {
    return path.join(TENANTS_DIR, `tenant_${tenantId}.db`);
}

function getMigrationFiles() {
    const files = fs.readdirSync(MIGRATIONS_DIR)
        .filter(f => f.endsWith('.sql') || f.endsWith('.js'))
        .sort();
    console.log(`📁 Encontrados ${files.length} arquivos de migração:`);
    files.forEach(f => console.log(`   - ${f}`));
    return files;
}

function ensureMigrationsTable(db) {
    return new Promise((resolve, reject) => {
        db.run(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version TEXT PRIMARY KEY,
                applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

function getAppliedMigrations(db) {
    return new Promise((resolve, reject) => {
        db.all('SELECT version FROM schema_migrations ORDER BY version', (err, rows) => {
            if (err) reject(err);
            else resolve(rows.map(r => r.version));
        });
    });
}

function applyMigration(db, version, sql) {
    return new Promise((resolve) => {
        console.log(`\n🔄 Aplicando migração ${version}...`);
        
        db.exec(sql, (err) => {
            if (err) {
                console.error(`❌ Erro ao aplicar migração ${version}:`, err.message);
                
                // Se for erro de coluna/tabela já existente, tenta continuar
                if (err.message.includes('already exists') || err.message.includes('duplicate column name')) {
                    console.log(`⚠️  Alguns elementos já existem, continuando...`);
                } else {
                    resolve(false);
                    return;
                }
            }
            
            // Registra a migração como aplicada
            db.run('INSERT INTO schema_migrations (version) VALUES (?)', [version], (err) => {
                if (err && !err.message.includes('UNIQUE constraint failed')) {
                    console.log(`⚠️  Migração ${version} pode já ter sido registrada`);
                } else {
                    console.log(`✅ Migração ${version} aplicada com sucesso!`);
                }
                resolve(true);
            });
        });
    });
}

function ensureCriticalColumns(db) {
    return new Promise((resolve) => {
        console.log('\n🔍 Verificando colunas críticas...');
        
        const tables = {
            persons: [
                { name: 'street_number', sql: "ALTER TABLE persons ADD COLUMN street_number TEXT;" },
                { name: 'address_complement', sql: "ALTER TABLE persons ADD COLUMN address_complement TEXT;" },
                { name: 'nationality', sql: "ALTER TABLE persons ADD COLUMN nationality TEXT;" },
                { name: 'naturality', sql: "ALTER TABLE persons ADD COLUMN naturality TEXT;" },
                { name: 'extension', sql: "ALTER TABLE persons ADD COLUMN extension TEXT;" },
                { name: 'social_name', sql: "ALTER TABLE persons ADD COLUMN social_name TEXT;" },
                { name: 'registry_name', sql: "ALTER TABLE persons ADD COLUMN registry_name TEXT;" },
                { name: 'access_start_date', sql: "ALTER TABLE persons ADD COLUMN access_start_date DATETIME;" },
                { name: 'access_end_date', sql: "ALTER TABLE persons ADD COLUMN access_end_date DATETIME;" },
                { name: 'face_embedding', sql: "ALTER TABLE persons ADD COLUMN face_embedding TEXT;" }
            ],
            visitors: [
                { name: 'face_embedding', sql: "ALTER TABLE visitors ADD COLUMN face_embedding TEXT;" },
                { name: 'card_number', sql: "ALTER TABLE visitors ADD COLUMN card_number TEXT;" },
                { name: 'card_type', sql: "ALTER TABLE visitors ADD COLUMN card_type TEXT DEFAULT 'manual';" },
                { name: 'liberation_type', sql: "ALTER TABLE visitors ADD COLUMN liberation_type TEXT DEFAULT 'unica';" },
                { name: 'period_start', sql: "ALTER TABLE visitors ADD COLUMN period_start DATETIME;" },
                { name: 'period_end', sql: "ALTER TABLE visitors ADD COLUMN period_end DATETIME;" },
                { name: 'expected_exit_date', sql: "ALTER TABLE visitors ADD COLUMN expected_exit_date DATETIME;" },
                { name: 'photo_base64', sql: "ALTER TABLE visitors ADD COLUMN photo_base64 TEXT;" }
            ],
            holidays: [
                { name: 'repeat_annual', sql: "ALTER TABLE holidays ADD COLUMN repeat_annual INTEGER DEFAULT 0;" }
            ],
            parkings: [
                { name: 'empresas', sql: "ALTER TABLE parkings ADD COLUMN empresas TEXT DEFAULT NULL;" }
            ],
            companies: [
                { name: 'city', sql: "ALTER TABLE companies ADD COLUMN city TEXT;" },
                { name: 'state', sql: "ALTER TABLE companies ADD COLUMN state TEXT;" }
            ],
            vehicles: [
                { name: 'observacao', sql: "ALTER TABLE vehicles ADD COLUMN observacao TEXT;" }
            ]
        };
        
        let tablesChecked = 0;
        const totalTables = Object.keys(tables).length;
        
        for (const [tableName, columns] of Object.entries(tables)) {
            db.all(`PRAGMA table_info('${tableName}')`, (err, tableInfo) => {
                tablesChecked++;
                
                if (err) {
                    console.log(`   ⚠️  Erro ao verificar tabela '${tableName}':`, err.message);
                } else {
                    const existingColumns = tableInfo.map(c => c.name);
                    
                    columns.forEach(col => {
                        if (!existingColumns.includes(col.name)) {
                            console.log(`   ➕ Adicionando coluna '${col.name}' na tabela '${tableName}'`);
                            db.run(col.sql, (e) => {
                                if (e) {
                                    console.log(`   ⚠️  Erro ao adicionar coluna '${col.name}':`, e.message);
                                } else {
                                    console.log(`   ✅ Coluna '${col.name}' adicionada com sucesso!`);
                                }
                            });
                        } else {
                            console.log(`   ✓ Coluna '${col.name}' já existe na tabela '${tableName}'`);
                        }
                    });
                }
                
                if (tablesChecked === totalTables) {
                    resolve();
                }
            });
        }
    });
}

function ensureTablesExist(db) {
    return new Promise((resolve) => {
        console.log('\n🔍 Verificando tabelas básicas...');
        
        const requiredTables = [
            'users', 'groups', 'companies', 'persons', 'vehicles', 
            'visitors', 'company_owners', 'system_config', 'audit_logs', 
            'backups', 'export_jobs', 'person_groups', 'holidays', 
            'schedules', 'schedule_ranges', 'cafeterias', 'keyholders',
            'parkings', 'parking_spots', 'tenant_limits', 'revendas',
            'revenda_tenants', 'password_reset_codes', 'price_tables', 
            'price_ranges'
        ];
        
        let tablesChecked = 0;
        
        requiredTables.forEach(table => {
            db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get((err) => {
                tablesChecked++;
                if (err) {
                    console.log(`   ⚠️  Tabela '${table}' não existe:`, err.message);
                } else {
                    console.log(`   ✓ Tabela '${table}' existe`);
                }
                
                if (tablesChecked === requiredTables.length) {
                    resolve();
                }
            });
        });
    });
}

// Insere feriados nacionais brasileiros padrão
function insertDefaultHolidays(db, tenantId) {
    return new Promise((resolve) => {
        console.log('\n🎉 Inserindo feriados nacionais brasileiros...');
        
        const holidays = [
            { name: 'Confraternização Universal', date: '01-01', type: 'national', description: 'Ano Novo' },
            { name: 'Tiradentes', date: '21-04', type: 'national', description: 'Dia de Tiradentes' },
            { name: 'Dia do Trabalho', date: '01-05', type: 'national', description: 'Dia Internacional do Trabalho' },
            { name: 'Independência do Brasil', date: '07-09', type: 'national', description: 'Dia da Independência do Brasil' },
            { name: 'Finados', date: '02-11', type: 'national', description: 'Dia de Finados' },
            { name: 'Proclamação da República', date: '15-11', type: 'national', description: 'Dia da Proclamação da República' },
            { name: 'Natal', date: '25-12', type: 'national', description: 'Natal' }
        ];
        
        // Primeiro desabilita foreign keys para evitar problemas
        db.exec('PRAGMA foreign_keys=OFF;', (err) => {
            if (err) {
                console.log(`   ⚠️  Erro ao desabilitar foreign keys:`, err.message);
            }
            
            // Primeiro verifica se já existem feriados para este tenant
            db.all('SELECT COUNT(*) as count FROM holidays WHERE tenant_id = ?', [tenantId], (err, rows) => {
                if (err) {
                    console.log(`   ⚠️  Erro ao verificar feriados:`, err.message);
                    resolve();
                    return;
                }
                
                const existingCount = rows[0]?.count || 0;
                if (existingCount > 0) {
                    console.log(`   ✓ Já existem ${existingCount} feriados cadastrados para este tenant`);
                    // Reabilita foreign keys
                    db.exec('PRAGMA foreign_keys=ON;');
                    resolve();
                    return;
                }
                
                // Insere os feriados
                let inserted = 0;
                holidays.forEach(holiday => {
                    const sql = `INSERT INTO holidays (tenant_id, name, date, type, description, repeat_annual) 
                                 VALUES (?, ?, ?, ?, ?, 1)`;
                    db.run(sql, [tenantId, holiday.name, holiday.date, holiday.type, holiday.description], (e) => {
                        if (e) {
                            console.log(`   ⚠️  Erro ao inserir ${holiday.name}:`, e.message);
                        } else {
                            inserted++;
                        }
                        
                        // Quando todos foram inseridos
                        if (inserted === holidays.length) {
                            console.log(`   ✅ ${inserted} feriados nacionais inseridos com sucesso!`);
                            // Reabilita foreign keys
                            db.exec('PRAGMA foreign_keys=ON;');
                            resolve();
                        }
                    });
                });
            });
        });
    });
}

async function runMigrations(tenantId) {
    console.log(`\n🚀 Iniciando migrações para tenant: ${tenantId}`);
    console.log('='.repeat(50));
    
    const dbPath = getTenantDbPath(tenantId);
    console.log(`📂 Pasta tenants: ${TENANTS_DIR}`);
    console.log(`📂 Banco de dados: ${dbPath}`);
    
    // Verifica se o banco de dados existe
    if (!fs.existsSync(dbPath)) {
        console.error(`❌ Banco de dados não encontrado: ${dbPath}`);
        process.exit(1);
    }
    
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, async (err) => {
            if (err) {
                console.error('❌ Erro ao conectar ao banco de dados:', err.message);
                reject(err);
                return;
            }
            
            try {
                // Garante que a tabela de migrações existe
                await ensureMigrationsTable(db);
                
                // Obtém as migrações já aplicadas
                const appliedMigrations = await getAppliedMigrations(db);
                console.log(`\n📋 Migrações já aplicadas: ${appliedMigrations.length}`);
                if (appliedMigrations.length > 0) {
                    appliedMigrations.forEach(m => console.log(`   ✓ ${m}`));
                }
                
                // Obtém os arquivos de migração
                const migrationFiles = getMigrationFiles();
                
                // Aplica cada migração
                let appliedCount = 0;
                for (const file of migrationFiles) {
                    const version = file.replace(/\.(sql|js)$/, '');
                    
                    if (appliedMigrations.includes(version)) {
                        console.log(`\n⏭️  Pulando ${version} (já aplicada)`);
                        continue;
                    }
                    
                    let success = false;
                    if (file.endsWith('.sql')) {
                        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
                        success = await applyMigration(db, version, sql);
                    } else if (file.endsWith('.js')) {
                        console.log(`\n🔄 Aplicando migração JS ${version}...`);
                        try {
                            const modulePath = path.join(MIGRATIONS_DIR, file);
                            const { migrate } = await import(`file://${modulePath}`);
                            
                            // Wrap db in a simple promise-based interface similar to what the app expects
                            const dbAsync = {
                                all: (sql, params) => new Promise((res, rej) => db.all(sql, params, (err, rows) => err ? rej(err) : res(rows))),
                                run: (sql, params) => new Promise((res, rej) => db.run(sql, params, function(err) { err ? rej(err) : res({ lastID: this.lastID, changes: this.changes }) })),
                                exec: (sql) => new Promise((res, rej) => db.exec(sql, (err) => err ? rej(err) : res()))
                            };

                            if (typeof migrate === 'function') {
                                await migrate(dbAsync);
                                
                                // Registrar a migração como aplicada
                                await new Promise((res, rej) => {
                                    db.run('INSERT INTO schema_migrations (version) VALUES (?)', [version], (err) => {
                                        if (err) rej(err);
                                        else res();
                                    });
                                });
                                console.log(`✅ Migração JS ${version} aplicada com sucesso!`);
                                success = true;
                            } else {
                                console.error(`❌ Migração JS ${version} não exporta função 'migrate'`);
                                continue; // Skip to next extension for same version
                            }
                        } catch (err) {
                            console.error(`❌ Erro ao aplicar migração JS ${version}:`, err.message);
                        }
                    }
                    
                    if (success) {
                      appliedMigrations.push(version);
                      appliedCount++;
                    }
                }
                
                // Garante que todas as colunas críticas existam
                await ensureCriticalColumns(db);
                
                // Verifica as tabelas
                await ensureTablesExist(db);
                
                // Insere feriados nacionais brasileiros
                await insertDefaultHolidays(db, tenantId);
                
                console.log('\n' + '='.repeat(50));
                console.log(`✅ Migrações concluídas!`);
                console.log(`   Novas migrações aplicadas: ${appliedCount}`);
                const totalMigrations = await getAppliedMigrations(db);
                console.log(`   Total de migrações aplicadas: ${totalMigrations.length}`);
                
                db.close((closeErr) => {
                    if (closeErr) {
                        console.log('⚠️  Erro ao fechar banco de dados:', closeErr.message);
                    }
                    resolve();
                });
                
            } catch (error) {
                console.error('\n❌ Erro durante as migrações:', error.message);
                console.error(error.stack);
                db.close();
                reject(error);
            }
        });
    });
}

// Função para listar tenants disponíveis
function listTenants() {
    console.log('\n📂 Tenants disponíveis:');
    const files = fs.readdirSync(TENANTS_DIR)
        .filter(f => f.startsWith('tenant_') && f.endsWith('.db'));
    
    if (files.length === 0) {
        console.log('   Nenhum tenant encontrado!');
    } else {
        files.forEach(f => {
            const tenantId = f.replace('tenant_', '').replace('.db', '');
            console.log(`   - ${tenantId}`);
        });
    }
    console.log('');
}

// Função para obter todos os tenants
function getAllTenants() {
    const files = fs.readdirSync(TENANTS_DIR)
        .filter(f => f.startsWith('tenant_') && f.endsWith('.db'));
    return files.map(f => f.replace('tenant_', '').replace('.db', ''));
}

// Parse dos argumentos da linha de comando
const args = process.argv.slice(2);

if (args.length === 0) {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║         Script de Migração do Banco de Dados              ║
╚════════════════════════════════════════════════════════════╝

Uso: node migrations.js <tenant_id|all>

Exemplos:
  node migrations.js default        # Executa em um tenant específico
  node migrations.js mamsolucoes    # Executa em um tenant específico
  node migrations.js all            # Executa em TODOS os tenants

Tenants disponíveis:
`);
    listTenants();
    process.exit(0);
}

const tenantId = args[0];

// Executa em todos os tenants
if (tenantId === 'all') {
    const tenants = getAllTenants();
    console.log(`\n🎯 Executando migrações em ${tenants.length} tenants...\n`);
    
    async function runAll() {
        let successCount = 0;
        let failCount = 0;
        
        for (const tenant of tenants) {
            console.log(`\n${'='.repeat(60)}`);
            console.log(`📦 PROCESSANDO TENANT: ${tenant}`);
            console.log('='.repeat(60));
            
            try {
                await runMigrations(tenant);
                successCount++;
            } catch (error) {
                console.error(`❌ Falha no tenant ${tenant}:`, error.message);
                failCount++;
            }
        }
        
        console.log(`\n${'='.repeat(60)}`);
        console.log('📊 RESUMO TOTAL:');
        console.log(`   ✅ Sucesso: ${successCount}/${tenants.length}`);
        console.log(`   ❌ Falhas: ${failCount}/${tenants.length}`);
        console.log('='.repeat(60));
        
        if (failCount > 0) {
            process.exit(1);
        }
    }
    
    runAll()
        .then(() => {
            console.log('\n🎉 Todas as migrações finalizadas com sucesso!');
            process.exit(0);
        })
        .catch((error) => {
            console.error('\n💥 Erro geral:', error.message);
            process.exit(1);
        });
} else {
    runMigrations(tenantId)
        .then(() => {
            console.log('\n🎉 Script finalizado com sucesso!');
            process.exit(0);
        })
        .catch((error) => {
            console.error('\n💥 Script falhou:', error.message);
            process.exit(1);
        });
}
