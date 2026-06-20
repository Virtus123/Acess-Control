import readline from 'readline';
import 'dotenv/config';
import dbManager from '../config/database.js';
import logger from '../config/logger.js';
import { hashPassword } from '../utils/generators.js';
import { validateEmail, validateCNPJ } from '../utils/validators.js';
import { runMigrations } from '../database/migrate.js';
import fs from 'fs/promises';
import path from 'path';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

async function main() {
  console.log('\n================================================');
  console.log('   MAM Control - Criador de Unidades (Tenants)   ');
  console.log('================================================\n');

  try {
    // 1. Coleta de Informações
    const tenant_id = await question('ID da Unidade (ex: cliente_xyz): ');
    if (!tenant_id || !/^[a-zA-Z0-9_-]+$/.test(tenant_id)) {
      throw new Error('ID da Unidade inválido. Use apenas letras, números, hífen e underscore.');
    }

    const company_name = await question('Razão Social / Nome da Empresa: ');
    if (!company_name) throw new Error('Razão Social é obrigatória.');

    const cnpj = await question('CNPJ (apenas números): ');
    if (!validateCNPJ(cnpj)) {
      throw new Error('CNPJ inválido.');
    }

    const admin_name = await question('Nome do Administrador: ');
    if (!admin_name) throw new Error('Nome do administrador é obrigatório.');

    const admin_email = await question('E-mail do Administrador: ');
    if (!validateEmail(admin_email)) {
      throw new Error('E-mail inválido.');
    }

    const admin_password = await question('Senha Inicial: ');
    if (admin_password.length < 6) {
      throw new Error('A senha deve ter no mínimo 6 caracteres.');
    }

    const max_pessoas_input = await question('Limite de Pessoas (padrão 1000): ');
    const max_pessoas = parseInt(max_pessoas_input) || 1000;

    const max_equipamentos_input = await question('Limite de Equipamentos (padrão 50): ');
    const max_equipamentos = parseInt(max_equipamentos_input) || 50;
    
    const phone = await question('Telefone: ');
    const city = await question('Cidade: ');
    const state = await question('Estado (UF): ');

    console.log('\n------------------------------------------------');
    console.log('Resumo da Unidade:');
    console.log(`ID: ${tenant_id}`);
    console.log(`Empresa: ${company_name}`);
    console.log(`CNPJ: ${cnpj}`);
    console.log(`Admin: ${admin_name} (${admin_email})`);
    console.log(`Limites: ${max_pessoas} pessoas, ${max_equipamentos} equipamentos`);
    console.log('------------------------------------------------\n');

    const confirm = await question('Confirma a criação? (s/n): ');
    if (confirm.toLowerCase() !== 's') {
      console.log('Operação cancelada.');
      return;
    }

    console.log('\nIniciando criação...');

    // 2. Inicialização de diretórios
    await dbManager.init();

    // 3. Verificar se tenant já existe
    const dbPath = dbManager.getTenantPath(tenant_id);
    try {
      await fs.access(dbPath);
      throw new Error(`O tenant "${tenant_id}" já existe. O arquivo ${dbPath} já está presente.`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    // 4. Criar banco de dados do tenant
    console.log('Criando arquivo de banco de dados...');
    const db = await dbManager.getConnection(tenant_id);

    // 5. Executar migrações
    console.log(`Aplicando migrações para "${tenant_id}"...`);
    await runMigrations(tenant_id);

    // 6. Atualizar limites
    console.log('Configurando limites...');
    await db.run(
      `UPDATE tenant_limits SET max_pessoas = ?, max_equipamentos = ?`,
      [max_pessoas, max_equipamentos]
    );

    // 7. Criar usuário admin
    console.log('Criando usuário administrador...');
    const hashedPassword = await hashPassword(admin_password);
    await db.run(
      `INSERT INTO users (name, email, password_hash, role, active)
       VALUES (?, ?, ?, ?, ?)`,
      [admin_name, admin_email, hashedPassword, 'admin', 1]
    );

    // 8. Criar empresa padrão
    console.log('Criando registro da empresa...');
    await db.run(
      `INSERT INTO companies (corporate_name, trading_name, cnpj, email, phone, city, state, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [company_name, company_name, cnpj, admin_email, phone || '', city || '', state || '', 1]
    );

    // 9. Fechar conexão
    await dbManager.closeConnection(tenant_id);

    console.log(`\n✅ Unidade "${tenant_id}" criada com sucesso!`);
    console.log(`Banco de dados localizado em: ${dbPath}`);
    console.log('\nVocê já pode acessar o sistema com as credenciais informadas.');

  } catch (error) {
    console.error(`\n❌ ERRO CRÍTICO: ${error.message}`);
    if (error.stack) logger.error(error.stack);
  } finally {
    rl.close();
    process.exit();
  }
}

main();
