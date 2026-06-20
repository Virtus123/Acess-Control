/**
 * Helpers para busca textual case/accent-insensitive em SQLite.
 *
 * Por que existe: SQLite com sqlite3 (não better-sqlite3) não suporta UDFs
 * registradas em runtime, e LIKE/COLLATE NOCASE só trata ASCII. Resultado:
 * "joão" não encontra "JOAO", "Conceição" não encontra "conceicao", etc.
 *
 * Solução: normalizar AMBOS os lados (coluna e termo de busca) removendo
 * acentos e diacríticos via REPLACE encadeados na coluna + Unicode normalize
 * em JS no termo. Funciona sem mudar schema e sem migração de banco.
 *
 * Custo: o índice em `name` deixa de ser usado (full scan). Para tabelas
 * com até ~10k linhas isso é aceitável (<50ms). Para volumes maiores,
 * considerar coluna `name_normalized` indexada.
 */

// Mapa cobre português (acentos+ç), espanhol (ñ) e principais europeus.
// Caracteres em ordem: maiúscula então minúscula.
const ACCENT_MAP = [
  ['Á', 'A'], ['á', 'a'],
  ['À', 'A'], ['à', 'a'],
  ['Â', 'A'], ['â', 'a'],
  ['Ã', 'A'], ['ã', 'a'],
  ['Ä', 'A'], ['ä', 'a'],
  ['Å', 'A'], ['å', 'a'],
  ['É', 'E'], ['é', 'e'],
  ['È', 'E'], ['è', 'e'],
  ['Ê', 'E'], ['ê', 'e'],
  ['Ë', 'E'], ['ë', 'e'],
  ['Í', 'I'], ['í', 'i'],
  ['Ì', 'I'], ['ì', 'i'],
  ['Î', 'I'], ['î', 'i'],
  ['Ï', 'I'], ['ï', 'i'],
  ['Ó', 'O'], ['ó', 'o'],
  ['Ò', 'O'], ['ò', 'o'],
  ['Ô', 'O'], ['ô', 'o'],
  ['Õ', 'O'], ['õ', 'o'],
  ['Ö', 'O'], ['ö', 'o'],
  ['Ú', 'U'], ['ú', 'u'],
  ['Ù', 'U'], ['ù', 'u'],
  ['Û', 'U'], ['û', 'u'],
  ['Ü', 'U'], ['ü', 'u'],
  ['Ç', 'C'], ['ç', 'c'],
  ['Ñ', 'N'], ['ñ', 'n'],
  ['Ý', 'Y'], ['ý', 'y'],
];

/**
 * Normaliza um termo de busca em JS: lowercase + remove diacríticos via NFD.
 * Use em conjunto com `buildAccentInsensitiveExpr()` no SQL.
 *
 * Exemplo:
 *   normalizeSearchTerm('João Conceição') === 'joao conceicao'
 */
export function normalizeSearchTerm(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove combining marks
    .toLowerCase();
}

/**
 * Retorna uma expressão SQL que normaliza a coluna (lowercase + sem acentos).
 * Use no WHERE: `WHERE ${buildAccentInsensitiveExpr('p.name')} LIKE ?`.
 *
 * O termo do LIKE deve ser passado JÁ normalizado por `normalizeSearchTerm()`.
 */
export function buildAccentInsensitiveExpr(column) {
  let expr = `LOWER(${column})`;
  for (const [from, to] of ACCENT_MAP) {
    // só substitui o lowercase, já fizemos LOWER() externamente
    if (from === from.toLowerCase()) {
      expr = `REPLACE(${expr}, '${from}', '${to.toLowerCase()}')`;
    }
  }
  return expr;
}
