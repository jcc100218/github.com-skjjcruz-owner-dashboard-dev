// Supabase stops granting Data API access to NEW tables in "public" on
// 2026-10-30 (owner notice 2026-10-20): a table created after that without an
// explicit GRANT answers "permission denied" to supabase-js / PostgREST, so
// the feature using it breaks. This fails the build when a table script
// creates a table without granting it:
//   - server/engine/schema.sql: every table must be in the grants list at the
//     bottom (the engine store is service-role only);
//   - supabase/migrations/* dated 2026-10-30 or later: every "create table"
//     needs a "grant ... on <table> ... to service_role" in the same file
//     (add anon / authenticated too if the browser reads it).
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const created = sql => [...sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi)].map(m => m[1].toLowerCase());
const problems = [];

const schema = fs.readFileSync(path.join(ROOT, 'server/engine/schema.sql'), 'utf8');
const list = (/foreach\s+t\s+in\s+array\s+array\[([^\]]*)\]/i.exec(schema) || [])[1] || '';
const granted = new Set([...list.matchAll(/'([a-z0-9_]+)'/gi)].map(m => m[1].toLowerCase()));
for (const t of created(schema)) if (!granted.has(t)) problems.push(`server/engine/schema.sql: table ${t} is not in the grants list at the bottom`);

const dir = path.join(ROOT, 'supabase/migrations');
for (const f of fs.readdirSync(dir).filter(n => /^\d{14}_.*\.sql$/.test(n) && n.slice(0, 8) >= '20261030')) {
  const sql = fs.readFileSync(path.join(dir, f), 'utf8');
  for (const t of created(sql)) {
    const re = new RegExp(`grant\\s[^;]*\\son\\s+(?:table\\s+)?(?:public\\.)?"?${t}"?\\s[^;]*\\bto\\s[^;]*\\bservice_role\\b`, 'i');
    if (!re.test(sql)) problems.push(`supabase/migrations/${f}: table ${t} has no "grant ... on public.${t} to service_role" (Supabase no longer grants new tables automatically)`);
  }
}

if (problems.length) {
  console.error('✗ table grants contract\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('✓ table grants contract: ' + granted.size + ' engine tables granted; new migrations grant their tables');
