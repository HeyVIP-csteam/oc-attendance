// Builds a self-contained, interactive HTML report (no external files, works offline): summary cards that filter,
// search, filters, sortable columns and printing. The data is embedded as JSON; the page script is generic and
// driven by the column / card definitions below. Everything is built in the browser (no Worker CPU time).

import { downloadBlob } from './files';

export type Cond = [field: string, op: '>' | '=' | '!=' | 'null' | 'notnull', value?: string | number];
export interface Agg { op: 'count' | 'sum' | 'distinct' | 'avg'; f?: string; where?: Cond; fmt?: 'n' | 'min' | 'dur' }
export interface RCol { k: string; label: string; t?: 'pid' | 'text' | 'cur' | 'min' | 'dur' | 'badge' | 'num' | 'red' }
export interface RKpi { label: string; cls?: '' | 'w' | 'r' | 'g'; value: Agg; sub?: { agg?: Agg; tpl: string }; click?: Cond }
export interface RFilter { k: string; label: string; all: string; desc?: boolean }
export interface ReportCfg {
  title: string; file: string; brand: string; brandSub: string;
  meta: [string, string][];          // header: label / value pairs; the last one goes on its own line (exported at / by)
  cols: RCol[]; rows: Record<string, unknown>[];
  search: string[]; searchLabel: string; searchPh: string;
  filters: RFilter[]; kpis: RKpi[];
  sort: { k: string; dir: 1 | -1 };
  foot: string;
  t: { reset: string; print: string; of: string; rows: string; none: string };
}

const CSS = `:root{--bg:#f4f6f9;--card:#fff;--ink:#0f172a;--mut:#64748b;--line:#e5e9f0;--pri:#2563eb;--pri2:#eef4ff;--ok:#15803d;--okb:#dcfce7;--bad:#b91c1c;--badb:#fee2e2;--warn:#b45309;--warnb:#fef3c7;--grey:#475569;--greyb:#eef1f5;--vio:#6d28d9;--viob:#ede9fe}
*{box-sizing:border-box}
body{margin:0;font-family:Inter,"Segoe UI",system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--ink);font-size:13.5px}
header{background:#fff;border-bottom:1px solid var(--line);padding:18px 28px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.logo{width:38px;height:38px;border-radius:10px;background:linear-gradient(135deg,#3b82f6,#6366f1);color:#fff;display:grid;place-items:center;font-weight:700;font-size:13px;flex:none}
header h1{margin:0;font-size:18px}header .sub{color:var(--mut);font-size:12.5px;margin-top:2px}
header .meta{margin-left:auto;text-align:right;color:var(--mut);font-size:12px;line-height:1.7}header .meta b{color:var(--ink)}
main{padding:20px 28px 40px;max-width:1600px;margin:0 auto}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:16px}
.kpi{background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.kpi.go{cursor:pointer;transition:border-color .12s}.kpi.go:hover{border-color:var(--pri)}.kpi.on{border-color:var(--pri);box-shadow:0 0 0 2px var(--pri2)}
.kpi .l{font-size:12px;color:var(--mut)}.kpi .v{font-size:22px;font-weight:700;margin-top:2px}.kpi .s{font-size:11.5px;color:var(--mut);min-height:14px}
.kpi.w .v{color:var(--warn)}.kpi.r .v{color:var(--bad)}.kpi.g .v{color:var(--ok)}
.bar{background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px 14px;display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:12px}
.bar label{font-size:11.5px;color:var(--mut);display:block;margin-bottom:3px}
.bar input,.bar select{padding:7px 10px;border:1px solid #d6dce5;border-radius:8px;font:inherit;background:#fff}
.bar input{width:220px}.bar .r{margin-left:auto;display:flex;gap:8px}
.btn{border:1px solid #d6dce5;background:#fff;border-radius:8px;padding:7px 14px;font:inherit;cursor:pointer}.btn:hover{background:#f8fafc}
.cnt{color:var(--mut);font-size:12.5px;margin:4px 2px 8px}
.tw{background:#fff;border:1px solid var(--line);border-radius:12px;overflow:auto;max-height:calc(100vh - 120px)}
table{width:100%;border-collapse:collapse}
th,td{padding:9px 12px;border-bottom:1px solid var(--line);border-right:1px solid var(--line);text-align:center;white-space:nowrap}
th:last-child,td:last-child{border-right:0}
th{background:var(--greyb);font-size:12px;color:var(--grey);font-weight:600;position:sticky;top:0;z-index:1;cursor:pointer;user-select:none}
th:hover{color:var(--ink)}th .ar{font-size:10px;margin-left:3px;color:var(--pri)}
.pid{text-align:left;font-weight:700}.txt{text-align:left;white-space:normal;min-width:120px}
tbody tr:hover td{background:#f8fbff}
.b{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11.5px;font-weight:600;background:var(--greyb);color:var(--grey)}
.b.ok{background:var(--okb);color:var(--ok)}.b.w{background:var(--warnb);color:var(--warn)}.b.r{background:var(--badb);color:var(--bad)}.b.i{background:var(--pri2);color:var(--pri)}.b.v{background:var(--viob);color:var(--vio)}
.red{color:#e60012;font-weight:700}.mut{color:#94a3b8}
.foot{color:var(--mut);font-size:11.5px;margin-top:14px;text-align:center}
@media (max-width:640px){header,main{padding-left:14px;padding-right:14px}header .meta{margin-left:0;text-align:left}.bar input{width:100%}}
@media print{.bar{display:none}body{background:#fff}.tw{max-height:none;overflow:visible;border:0}th{position:static}.kpi{break-inside:avoid}.kpi.on{box-shadow:none}}`;

// the page script (plain ES2017, no dependencies)
const JS = `(function(){
var C=JSON.parse(document.getElementById('cfg').textContent),R=C.rows,$=function(i){return document.getElementById(i)};
var esc=function(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})};
var p2=function(n){return String(n).padStart(2,'0')};
var hm=function(m){m=Math.round(m);return m>=60?Math.floor(m/60)+'h '+p2(m%60)+'m':m+'m'};
var F={n:function(v){return v==null?'—':String(v)},min:function(v){return v==null?'—':hm(v)},dur:function(v){return v==null?'—':hm(v/60000)}};
var test=function(r,c){var v=r[c[0]];switch(c[1]){case '>':return v!=null&&v>c[2];case '=':return v===c[2];case '!=':return v!==c[2];case 'null':return v==null;default:return v!=null}};
var agg=function(rows,a){var x=a.where?rows.filter(function(r){return test(r,a.where)}):rows,v;
 if(a.op==='count')v=x.length;else if(a.op==='distinct'){var s={};x.forEach(function(r){s[r[a.f]]=1});v=Object.keys(s).length}
 else{var t=0,n=0;x.forEach(function(r){if(r[a.f]!=null){t+=r[a.f];n++}});v=a.op==='sum'?t:(n?t/n:null)}
 return F[a.fmt||'n'](v)};
var cell=function(c,r){var v=r[c.k];
 if(c.t==='min')return v==null?'—':v>0?'<span class="red">'+hm(v)+'</span>':'0';
 if(c.t==='red')return v?'<span class="red">'+esc(v)+'</span>':esc(v==null?'—':v);
 if(c.t==='dur')return F.dur(v);
 if(c.t==='cur')return v?'<span class="b i">'+esc(v)+'</span>':'—';
 if(c.t==='badge')return v?'<span class="b '+esc(r[c.k+'_c']||'')+'">'+esc(v)+'</span>':'—';
 return v==null||v===''?'<span class="mut">—</span>':esc(v)};
var sort=C.sort,card=-1;
C.filters.forEach(function(f){var s={};R.forEach(function(r){if(r[f.k]!=null&&r[f.k]!=='')s[r[f.k]]=1});var o=Object.keys(s).sort();if(f.desc)o.reverse();
 $('f_'+f.k).innerHTML='<option value="">'+esc(f.all)+'</option>'+o.map(function(v){return '<option>'+esc(v)+'</option>'}).join('')});
function rows(){var q=$('q').value.trim().toLowerCase();
 return R.filter(function(r){
  if(q&&!C.search.some(function(k){return String(r[k]||'').toLowerCase().indexOf(q)>=0}))return false;
  for(var i=0;i<C.filters.length;i++){var f=C.filters[i],v=$('f_'+f.k).value;if(v&&String(r[f.k])!==v)return false}
  return card<0||test(r,C.kpis[card].click)})}
function draw(){var x=rows();
 $('kpis').innerHTML=C.kpis.map(function(k,i){return '<div class="kpi '+(k.cls||'')+(k.click?' go':'')+(card===i?' on':'')+'" data-i="'+i+'"><div class="l">'+esc(k.label)+'</div><div class="v">'+agg(x,k.value)+'</div><div class="s">'+(k.sub?esc(k.sub.tpl.replace('{}',k.sub.agg?agg(x,k.sub.agg):'')):'')+'</div></div>'}).join('');
 var kv=function(r){var v=r[sort.k];return v==null?(sort.dir>0?Infinity:-Infinity):v};
 x.sort(function(a,b){var A=kv(a),B=kv(b);return(A>B?1:A<B?-1:String(a[C.cols[0].k]).localeCompare(String(b[C.cols[0].k])))*sort.dir});
 $('hd').innerHTML=C.cols.map(function(c){return '<th class="'+(c.t==='pid'?'pid':'')+'" data-k="'+c.k+'">'+esc(c.label)+(sort.k===c.k?'<span class="ar">'+(sort.dir>0?'▲':'▼')+'</span>':'')+'</th>'}).join('');
 $('tb').innerHTML=x.length?x.map(function(r){return '<tr>'+C.cols.map(function(c){return '<td class="'+(c.t==='pid'?'pid':c.t==='text'?'txt':'')+'">'+cell(c,r)+'</td>'}).join('')+'</tr>'}).join(''):'<tr><td colspan="'+C.cols.length+'" class="mut" style="padding:24px">'+esc(C.t.none)+'</td></tr>';
 $('cnt').textContent=x.length+' '+C.t.of+' '+R.length+' '+C.t.rows}
$('kpis').onclick=function(e){var k=e.target.closest('.kpi.go');if(!k)return;var i=+k.getAttribute('data-i');card=card===i?-1:i;draw()};
$('hd').onclick=function(e){var h=e.target.closest('th');if(!h)return;var k=h.getAttribute('data-k');sort={k:k,dir:sort.k===k?-sort.dir:1};draw()};
$('q').oninput=draw;C.filters.forEach(function(f){$('f_'+f.k).onchange=draw});
$('reset').onclick=function(){$('q').value='';C.filters.forEach(function(f){$('f_'+f.k).value=''});card=-1;sort=C.sort;draw()};
$('print').onclick=function(){window.print()};
draw()})();`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function buildHtmlReport(c: ReportCfg): string {
  // the data goes into a JSON script block; "<" is escaped so no text can close the block
  const json = JSON.stringify(c).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(c.title)} · ${esc(c.meta[0]?.[1] ?? '')}</title><style>${CSS}</style></head>
<body>
<header><div class="logo">OC</div><div><h1>${esc(c.title)}</h1><div class="sub">${esc(c.brand)} · ${esc(c.brandSub)}</div></div>
<div class="meta">${c.meta.slice(0, -1).map(([l, v]) => `${esc(l)} <b>${esc(v)}</b>`).join(' · ')}<br>${c.meta.slice(-1).map(([l, v]) => `${esc(l)} <b>${esc(v)}</b>`).join('')}</div></header>
<main>
<div class="kpis" id="kpis"></div>
<div class="bar">
<div><label>${esc(c.searchLabel)}</label><input type="search" id="q" placeholder="${esc(c.searchPh)}"></div>
${c.filters.map((f) => `<div><label>${esc(f.label)}</label><select id="f_${esc(f.k)}"></select></div>`).join('')}
<div class="r"><button class="btn" id="reset">${esc(c.t.reset)}</button><button class="btn" id="print">${esc(c.t.print)}</button></div>
</div>
<div class="cnt" id="cnt"></div>
<div class="tw"><table><thead><tr id="hd"></tr></thead><tbody id="tb"></tbody></table></div>
<div class="foot">${esc(c.foot)}</div>
</main>
<script type="application/json" id="cfg">${json}</script>
<script>${JS}</script>
</body></html>`;
}

export function downloadHtmlReport(c: ReportCfg) {
  downloadBlob(c.file, new Blob([buildHtmlReport(c)], { type: 'text/html;charset=utf-8' }));
}
