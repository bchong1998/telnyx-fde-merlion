#!/bin/sh
# assistant/recent.sh — list the latest 5 conversations for this assistant.
set -eu
KEY="${TELNYX_API_KEY:-}"
if [ -z "$KEY" ]; then
  KEY=$(sed -n 's/^api_key = "\(.*\)"/\1/p' "$HOME/.telnyx-edge/config.toml")
fi
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
AID=$(sed -n 's/.*"assistant_id": *"\([^"]*\)".*/\1/p' "$DIR/state.json" | head -1)
if [ -z "$AID" ]; then echo "assistant/state.json missing or has no assistant_id — run deploy first" >&2; exit 1; fi
curl -sS "https://api.telnyx.com/v2/ai/conversations?page%5Bsize%5D=50" \
  -H "Authorization: Bearer $KEY" | AID="$AID" node -e '
let d="";
process.stdin.on("data",c=>d+=c).on("end",()=>{
  const r=JSON.parse(d);
  const rows=(r.data??[])
    .filter(c=>c.metadata?.assistant_id===process.env.AID)
    .sort((a,b)=>(b.created_at??"").localeCompare(a.created_at??""))
    .slice(0,5);
  if(!rows.length){console.log("(no conversations found for",process.env.AID+")");return;}
  for(const c of rows){
    const tools=(c.metadata?.called_tools??[]).join(",")||"-";
    console.log(`${c.created_at}  ${c.id}  ${c.name??""}  tools:${tools}`);
  }
});'
