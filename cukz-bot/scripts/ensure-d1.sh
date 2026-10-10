#!/usr/bin/env bash
# Creates the cukz-bot D1 database if needed, writes its id into wrangler.toml and applies the schema.
set -euo pipefail
cd "$(dirname "$0")/.."
find_id='const l=JSON.parse(require("fs").readFileSync(0,"utf8"));const d=l.find(x=>x.name==="cukz-bot");console.log(d?d.uuid:"")'
id=$(npx wrangler d1 list --json | node -e "$find_id")
if [ -z "$id" ]; then
  npx wrangler d1 create cukz-bot --update-config=false --location=apac >/dev/null
  id=$(npx wrangler d1 list --json | node -e "$find_id")
fi
node -e 'const fs=require("fs");fs.writeFileSync("wrangler.toml",fs.readFileSync("wrangler.toml","utf8").replace(/database_id = "[^"]*"/,`database_id = "${process.argv[1]}"`))' "$id"
npx wrangler d1 execute cukz-bot --remote --yes --file schema.sql >/dev/null
echo "D1 database: $id"
