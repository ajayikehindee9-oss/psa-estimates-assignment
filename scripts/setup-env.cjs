const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const templatePath = path.join(root, '.env.local.template');
const envPath = path.join(root, '.env.local');

if (fs.existsSync(envPath)) {
  console.log('.env.local already exists — leaving it unchanged.');
  process.exit(0);
}

if (!fs.existsSync(templatePath)) {
  console.error('ERROR: .env.local.template is missing.\n');
  process.exit(1);
}

fs.copyFileSync(templatePath, envPath);
console.log('Created .env.local from .env.local.template.');
console.log('Fill in your Supabase URL and keys, then continue setup.');
