#!/usr/bin/env bash
# Creates the cukz-bot D1 database if needed, writes its id into wrangler.toml and applies the schema.
set -euo pipefail
cd "$(dirname "$0")/.."
id=$(npx wrangler d1 list --json | node -e 'const l=JSON.parse(require("fs").readFileSync(0,"utf8"));const d=l.find(x=>x.name==="cukz-bot");console.log(d?d.uuid:"")')
if [ -z "$id" ]; then
  npx wrangler d1 create cukz-bot --update-config=false --location=apac >/dev/null
  id=$(npx wrangler d1 list --json | node -e 'const l=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(l.find(x=>x.name==="cukz-bot").uuid)')
fi
sed -i "s/__D1_ID__/$id/" wrangler.toml
npx wrangler d1 execute cukz-bot --remote --yes --file schema.sql >/dev/null
echo "D1 database: $id"
