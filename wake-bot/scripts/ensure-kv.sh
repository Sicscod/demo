#!/usr/bin/env bash
# Creates the wake-bot KV namespace if needed and writes its id into wrangler.toml.
set -euo pipefail
cd "$(dirname "$0")/.."
find_id='const l=JSON.parse(require("fs").readFileSync(0,"utf8"));const n=l.find(x=>x.title==="wake-bot"||x.title.endsWith("-wake-bot"));console.log(n?n.id:"")'
id=$(npx wrangler kv namespace list | node -e "$find_id")
if [ -z "$id" ]; then
  npx wrangler kv namespace create wake-bot --update-config=false >/dev/null
  id=$(npx wrangler kv namespace list | node -e "$find_id")
fi
[ -n "$id" ] || { echo "Could not create the wake-bot KV namespace." >&2; exit 1; }
node -e 'const fs=require("fs");fs.writeFileSync("wrangler.toml",fs.readFileSync("wrangler.toml","utf8").replace(/^id = "[^"]*"/m,`id = "${process.argv[1]}"`))' "$id"
echo "KV namespace: $id"
