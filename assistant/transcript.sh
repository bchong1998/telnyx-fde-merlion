#!/bin/sh
# assistant/transcript.sh <conversation_id>
# Prints the conversation transcript (chronological) with tool calls/results.
set -eu
CID="${1:?usage: transcript.sh <conversation_id>}"
KEY="${TELNYX_API_KEY:-}"
if [ -z "$KEY" ]; then
  KEY=$(sed -n 's/^api_key = "\(.*\)"/\1/p' "$HOME/.telnyx-edge/config.toml")
fi
curl -sS "https://api.telnyx.com/v2/ai/conversations/$CID/messages" \
  -H "Authorization: Bearer $KEY" | node -e '
let d="";
process.stdin.on("data",c=>d+=c).on("end",()=>{
  const r=JSON.parse(d);
  if(!r.data){console.log(JSON.stringify(r).slice(0,500));return;}
  const msgs=[...r.data].reverse(); // API returns newest first
  for(const m of msgs){
    const node=m.metadata?.flow_node_id?` [${m.metadata.flow_node_id}]`:"";
    const who=(m.name??m.role);
    if(Array.isArray(m.tool_calls))for(const tc of m.tool_calls){
      const fn=tc.function??{};
      console.log(`${who}${node} CALLS ${fn.name}(${String(fn.arguments??"").slice(0,220)})`);
    }
    if(m.role==="tool"){
      console.log(`tool-result${node}: ${String(m.text??"").slice(0,300)}`);
    } else if((m.text??"").trim()!==""){
      console.log(`${who}${node}: ${m.text}`);
    }
  }
});'
