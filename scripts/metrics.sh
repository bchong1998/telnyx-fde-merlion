#!/bin/sh
# scripts/metrics.sh [since]  (default window: 2h)
#
# Prints request count, 5xx rate and p50/p95/p99 for both functions from
# `telnyx-edge metrics <fn> --json`. ALERTs when the 5xx rate > 1% or the
# webhook p95 > 1500 ms (the /dv assistant timeout is 3000 ms; we want the
# webhook well under it at p95).
set -u
SINCE="${1:-2h}"

for FN in merlion-webhook merlion-mcp; do
  telnyx-edge metrics "$FN" --json --since "$SINCE" 2>/dev/null | FN="$FN" node -e '
let d="";
process.stdin.on("data",c=>d+=c).on("end",()=>{
  const fn=process.env.FN;
  let j; try{ j=JSON.parse(d); }catch{ console.log(JSON.stringify({fn, error:"metrics JSON parse failed", raw:d.slice(0,120)})); return; }
  const rows=j.data??[];
  if(!rows.length){ console.log(JSON.stringify({fn, request_count:0, note:"no metrics in window"})); return; }
  const r=rows.reduce((a,b)=>({ 
    request_count:(a.request_count??0)+(b.request_count??0),
    request_success_count:(a.request_success_count??0)+(b.request_success_count??0),
    request_error_count:(a.request_error_count??0)+(b.request_error_count??0),
    request_client_error_count:(a.request_client_error_count??0)+(b.request_client_error_count??0),
    p50:Math.max(a.p50??0,b.request_latency_p50_ms??0),
    p95:Math.max(a.p95??0,b.request_latency_p95_ms??0),
    p99:Math.max(a.p99??0,b.request_latency_p99_ms??0),
  }),{});
  const fiveXx = r.request_count>0 ? (r.request_error_count??0)/r.request_count : 0;
  const alerts=[];
  if (fiveXx>0.01) alerts.push(`5xx rate ${(fiveXx*100).toFixed(2)}% > 1%`);
  if (fn==="merlion-webhook" && r.p95>1500) alerts.push(`webhook p95 ${Math.round(r.p95)}ms > 1500ms (dv timeout 3000ms)`);
  console.log(JSON.stringify({
    ts:new Date().toISOString(), fn,
    request_count:r.request_count,
    five_xx_rate:+fiveXx.toFixed(4),
    p50_ms:+r.p50.toFixed(1), p95_ms:+r.p95.toFixed(1), p99_ms:+r.p99.toFixed(1),
    ...(alerts.length?{alert:true,reasons:alerts}:{}),
  }));
  process.exit(alerts.length?1:0);
});' || true
done
