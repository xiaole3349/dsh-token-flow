// dsh-token-flow — 统计各群 / 私聊的 token 消耗与流向
//
// 数据来源：QQ 桥接写的 state/token-usage.jsonl（每个回合一行，含 cacheHit / cacheMiss /
// output / reasoning）。只读盘、不写任何东西，也不碰会话。
//
// 页面：<DSH 地址>/dsh-token-flow
// 接口：/dsh-token-flow/api?days=7    /dsh-token-flow/csv?days=7
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'token-flow'
export const inject = ['webServer']

const 用量文件 = process.env.TOKEN_USAGE_FILE
  || join(homedir(), '.dsh', 'jingjing', 'bridges', 'qq-bridge-jingjing', 'state', 'token-usage.jsonl')

const 名 = (key, 名表) => {
  if (!key) return '（未知）'
  if (key.startsWith('group:')) {
    const id = key.slice(6)
    return (名表 && 名表.get('group:' + id)) || ('群 ' + id)
  }
  if (key.startsWith('private:')) {
    const id = key.slice(8)
    if (id === '374721531') return '爹爹'
    return (名表 && 名表.get('private:' + id)) || ('私聊 ' + id)
  }
  if (key.startsWith('internal:')) return '内部 · ' + key.slice(9)
  return key
}

// 群名表：向 SnowLuma 要一次群列表，缓存 10 分钟；要不到就用旧的缓存文件。
const 桥配置 = join(homedir(), '.dsh', 'jingjing', 'bridges', 'qq-bridge-jingjing', 'config.json')
const 群名缓存文件 = join(homedir(), '.dsh', 'jingjing', 'state', 'group-names.json')
let 群名缓存 = { at: 0, map: new Map() }

async function 群名表() {
  if (Date.now() - 群名缓存.at < 10 * 60 * 1000) return 群名缓存.map
  try {
    let base = 'http://127.0.0.1:3000'
    let token = ''
    try {
      const c = JSON.parse(readFileSync(桥配置, 'utf8'))
      base = c?.snowluma?.httpUrl || base
      token = c?.snowluma?.accessToken || ''
    } catch {}
    const r = await fetch(base.replace(/\/+$/, '') + '/get_group_list', {
      headers: { authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(4000),
    })
    const j = await r.json()
    const list = Array.isArray(j?.data) ? j.data : (Array.isArray(j?.data?.data) ? j.data.data : [])
    const map = new Map()
    for (const g of list) {
      const id = String(g?.group_id ?? g?.groupId ?? '')
      const name = String(g?.group_name ?? g?.groupName ?? '').trim()
      if (id && name) map.set('group:' + id, name)
    }
    if (map.size) {
      群名缓存 = { at: Date.now(), map }
      try { writeFileSync(群名缓存文件, JSON.stringify(Object.fromEntries(map), null, 2), 'utf8') } catch {}
      return map
    }
  } catch {}
  // 拿不到：退回磁盘缓存
  try {
    const j = JSON.parse(readFileSync(群名缓存文件, 'utf8'))
    const map = new Map(Object.entries(j || {}))
    if (map.size) { 群名缓存 = { at: Date.now(), map }; return map }
  } catch {}
  群名缓存 = { at: Date.now(), map: 群名缓存.map }
  return 群名缓存.map
}

// 峰谷：北京时间 周一至五 09:00–12:00、14:00–18:00 为峰价（不查节假日表，够看趋势）。
function 是峰价(ms) {
  const d = new Date(ms)
  const 周 = d.getDay()
  if (周 === 0 || 周 === 6) return false
  const m = d.getHours() * 60 + d.getMinutes()
  return (m >= 540 && m < 720) || (m >= 840 && m < 1080)
}

const 日 = (ms) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function 读行() {
  let 文本
  try { 文本 = readFileSync(用量文件, 'utf8') } catch { return null }
  const 出 = []
  let 坏行 = 0
  for (const 行 of 文本.split(/\r?\n/)) {
    if (!行.trim()) continue
    let r
    try { r = JSON.parse(行) } catch { 坏行++; continue }
    if (r.k !== 'turn') continue
    const b = r.b || {}
    出.push({
      t: Number(r.t) || 0,
      key: String(r.key || ''),
      模型: String(r.model || ''),
      命中: Number(b.cacheHit) || 0,
      未命中: Number(b.cacheMiss) || 0,
      写入: Number(b.cacheWrite) || 0,
      输出: Number(b.output) || 0,
    })
  }
  出.坏行 = 坏行
  出.坏 = false
  return 出
}

function 聚合(起, 名表 = new Map()) {
  const 全部 = 读行()
  if (!全部) return { 错: '还没有用量文件：' + 用量文件 }
  const 行们 = 全部.filter((r) => r.t >= 起)
  const 表 = new Map()
  const 会话天 = new Map()
  const 天表 = new Map()
  const 时段 = Array.from({ length: 24 }, () => ({ 回合: 0, token: 0 }))
  const 峰 = { 回合: 0, token: 0, 未命中: 0, 输出: 0 }
  const 谷 = { 回合: 0, token: 0, 未命中: 0, 输出: 0 }
  const 最贵 = []
  let 最早 = Infinity
  let 最晚 = 0

  for (const r of 行们) {
    const 总 = r.命中 + r.未命中 + r.写入 + r.输出
    r.总 = 总
    最早 = Math.min(最早, r.t); 最晚 = Math.max(最晚, r.t)
    const k = 名(r.key, 名表)
    if (!表.has(k)) 表.set(k, { 键: r.key, 会话: k, 回合: 0, 命中: 0, 未命中: 0, 写入: 0, 输出: 0, 总: 0, 模型: new Set(), 最大回合: 0 })
    const x = 表.get(k)
    x.回合++; x.命中 += r.命中; x.未命中 += r.未命中; x.写入 += r.写入; x.输出 += r.输出; x.总 += 总
    x.最大回合 = Math.max(x.最大回合, 总)
    if (r.模型) x.模型.add(r.模型)

    const dk = 日(r.t)
    if (!天表.has(dk)) 天表.set(dk, { 日: dk, 回合: 0, 总: 0, 未命中: 0, 输出: 0 })
    const d = 天表.get(dk)
    d.回合++; d.总 += 总; d.未命中 += r.未命中; d.输出 += r.输出

    // 每个会话自己的按天曲线（未命中才是真花钱的那部分）
    if (!会话天.has(k)) 会话天.set(k, new Map())
    const sk = 会话天.get(k)
    if (!sk.has(dk)) sk.set(dk, { 未命中: 0, 总: 0, 回合: 0 })
    const s2 = sk.get(dk)
    s2.未命中 += r.未命中; s2.总 += 总; s2.回合++

    时段[new Date(r.t).getHours()].回合++
    时段[new Date(r.t).getHours()].token += 总

    const 桶 = 是峰价(r.t) ? 峰 : 谷
    桶.回合++; 桶.token += 总; 桶.未命中 += r.未命中; 桶.输出 += r.输出

    最贵.push({ t: r.t, 会话: k, 模型: r.模型, 总, 未命中: r.未命中, 输出: r.输出 })
  }

  const 行 = [...表.values()].map((x) => ({
    ...x,
    模型: [...x.模型].join(','),
    命中率: x.命中 + x.未命中 > 0 ? x.命中 / (x.命中 + x.未命中) : 0,
    平均回合: x.回合 ? Math.round(x.总 / x.回合) : 0,
    平均输出: x.回合 ? Math.round(x.输出 / x.回合) : 0,
    实付: x.未命中 + x.输出,
    实付均: x.回合 ? Math.round((x.未命中 + x.输出) / x.回合) : 0,
  })).sort((a, b) => b.总 - a.总)

  const 合计 = 行.reduce((a, r) => ({
    回合: a.回合 + r.回合, 命中: a.命中 + r.命中, 未命中: a.未命中 + r.未命中,
    写入: a.写入 + r.写入, 输出: a.输出 + r.输出, 总: a.总 + r.总,
  }), { 回合: 0, 命中: 0, 未命中: 0, 写入: 0, 输出: 0, 总: 0 })

  最贵.sort((a, b) => b.总 - a.总)

  return {
    行,
    会话天: [...会话天.entries()]
      .map(([会话, m]) => ({ 会话, 点: [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([日, v]) => ({ 日, ...v })) }))
      .sort((a, b) => b.点.reduce((n, x) => n + x.未命中, 0) - a.点.reduce((n, x) => n + x.未命中, 0)),
    天: [...天表.values()].sort((a, b) => (a.日 < b.日 ? -1 : 1)),
    时段,
    峰谷: { 峰, 谷 },
    最贵: 最贵.slice(0, 10),
    合计,
    坏行: 全部.坏行,
    最早: 最早 === Infinity ? null : 最早,
    最晚: 最晚 || null,
    命中率: 合计.命中 + 合计.未命中 > 0 ? 合计.命中 / (合计.命中 + 合计.未命中) : 0,
    平均回合: 合计.回合 ? Math.round(合计.总 / 合计.回合) : 0,
  }
}

// 单个会话的详细流向（点表格里那一行时用）
function 聚合详(键, 起, 名表 = new Map()) {
  const 全部 = 读行()
  if (!全部) return { 错: '还没有用量文件：' + 用量文件 }
  const 行们 = 全部.filter((r) => r.key === 键 && r.t >= 起)
  const 天表 = new Map()
  const 时段 = Array.from({ length: 24 }, () => ({ 回合: 0, token: 0 }))
  const 模型 = new Map()
  const 峰 = { 回合: 0, token: 0, 未命中: 0, 输出: 0 }
  const 谷 = { 回合: 0, token: 0, 未命中: 0, 输出: 0 }
  const 最贵 = []
  const 合计 = { 回合: 0, 命中: 0, 未命中: 0, 写入: 0, 输出: 0, 总: 0 }
  let 最早 = Infinity

  for (const r of 行们) {
    const 总 = r.命中 + r.未命中 + r.写入 + r.输出
    r.总 = 总
    最早 = Math.min(最早, r.t)
    合计.回合++; 合计.命中 += r.命中; 合计.未命中 += r.未命中; 合计.写入 += r.写入; 合计.输出 += r.输出; 合计.总 += 总

    const dk = 日(r.t)
    if (!天表.has(dk)) 天表.set(dk, { 日: dk, 回合: 0, 总: 0, 未命中: 0, 输出: 0 })
    const d = 天表.get(dk)
    d.回合++; d.总 += 总; d.未命中 += r.未命中; d.输出 += r.输出

    时段[new Date(r.t).getHours()].回合++
    时段[new Date(r.t).getHours()].token += 总

    const m = r.模型 || '（未知）'
    模型.set(m, (模型.get(m) || 0) + 总)

    const 桶 = 是峰价(r.t) ? 峰 : 谷
    桶.回合++; 桶.token += 总; 桶.未命中 += r.未命中; 桶.输出 += r.输出

    最贵.push({ t: r.t, 总, 未命中: r.未命中, 输出: r.输出 })
  }

  最贵.sort((a, b) => b.总 - a.总)

  return {
    键, 名: 名(键, 名表),
    天: [...天表.values()].sort((a, b) => (a.日 < b.日 ? -1 : 1)),
    时段,
    模型: [...模型.entries()].map(([m, v]) => ({ 模型: m, token: v })).sort((a, b) => b.token - a.token),
    峰谷: { 峰, 谷 },
    最贵: 最贵.slice(0, 10),
    合计,
    命中率: 合计.命中 + 合计.未命中 > 0 ? 合计.命中 / (合计.命中 + 合计.未命中) : 0,
    平均回合: 合计.回合 ? Math.round(合计.总 / 合计.回合) : 0,
    平均输出: 合计.回合 ? Math.round(合计.输出 / 合计.回合) : 0,
    最早: 最早 === Infinity ? null : 最早,
  }
}

const 页面 = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Token 流向</title>
<style>
 body{background:#14161a;color:#dcdcdc;font:13px/1.7 "Microsoft YaHei",system-ui,sans-serif;margin:0;padding:20px 26px}
 h1{font-size:17px;margin:0 0 4px}.sub{color:#8a8a8a;font-size:12px;margin-bottom:16px}
 .bar{display:flex;gap:8px;margin-bottom:16px;align-items:center}
 .bar button{background:#1f2227;color:#dcdcdc;border:1px solid #2f333a;border-radius:6px;padding:4px 10px;cursor:pointer}
 .bar button.on{background:#2a3550;border-color:#3b4d78}
 .bar a{margin-left:auto;color:#8fb4ff;font-size:12px}
 table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:6px}
 th,td{text-align:right;padding:5px 8px;border-bottom:1px solid #23262b}
 th:first-child,td:first-child{text-align:left}
 th{color:#8a8a8a;font-weight:400}
 .k{color:#8fb4ff}
 .grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:18px}
 .card{background:#191b20;border:1px solid #24272d;border-radius:10px;padding:12px 14px}
 .card h3{margin:0 0 8px;font-size:13px;color:#bdbdbd;font-weight:600}
 .row{display:flex;justify-content:space-between;padding:3px 0;font-size:12px}
 .days{display:flex;gap:4px;align-items:flex-end;height:90px;margin:6px 0 2px}
 .days .d{flex:1;background:#3b4d78;border-radius:3px 3px 0 0;min-height:2px;position:relative}
 .days .d span{display:none}
 .hint{color:#6f747c;font-size:11px;margin-top:6px}
 .warn{color:#e0b070} html.light,html.light body{background:#f5f6f8;color:#23262b;color-scheme:light}
 html.light .card{background:#fff;border-color:#e3e6ea}
 html.light th{color:#6b7076}
 html.light th,html.light td{border-bottom-color:#e8ebef}
 html.light .bar button{background:#fff;border-color:#dfe3e8;color:#23262b}
 html.light .bar button.on{background:#e8efff;border-color:#b8caf0}
 html.light .hint{color:#7a8088}
 html.light .k{color:#2f63c9}
 html.light .box{background:#fff;border-color:#e3e6ea;color:#23262b}
 html.light .modal{background:rgba(0,0,0,.35)}
 .modal{position:fixed;inset:0;background:rgba(0,0,0,.62);display:none;align-items:center;justify-content:center;z-index:99}
 .modal.on{display:flex}
 .box{background:#191b20;border:1px solid #2b2f36;border-radius:12px;padding:16px 20px;width:min(820px,94vw);max-height:86vh;overflow:auto}
 .box h2{font-size:15px;margin:0 0 10px}
 .close{float:right;cursor:pointer;color:#8a8a8a;font-size:15px}
 .box table{margin-top:8px}
</style></head><body>
<h1>Token 流向</h1>
<div class="sub" id="sub">读取中…</div>
<div class="bar">
  <button data-d="1">今天</button><button data-d="7" class="on">近 7 天</button><button data-d="30">近 30 天</button><button data-d="0">全部</button>
  <a id="csv" href="#">导出 CSV</a>
  <button id="theme" type="button">夜间</button>
</div>
<table><thead><tr><th>会话</th><th>回合</th><th>未命中</th><th>命中</th><th>输出</th><th>总 token</th><th>命中率</th><th>均值/回合</th><th>平均输出</th><th>占比</th></tr></thead>
<tbody id="tb"></tbody></table>
<div class="card" style="margin-top:14px"><h3>各群按天（多线）</h3><div id="multi"></div></div>
<div class="card" style="margin-top:14px"><h3>每日总量（折线）</h3><div id="days"></div><div class="hint" id="daysHint"></div></div>
<div class="grid" style="margin-top:14px"><div class="card"><h3>会话占比（总 token）</h3><div id="pie"></div></div><div class="card"><h3>实付占比（未命中 + 输出）</h3><div id="pie2"></div></div></div>
<div class="grid">
  <div class="card"><h3>峰 / 谷</h3><div id="pv"></div></div>
  <div class="card"><h3>按小时</h3><div id="hv"></div></div>
</div>
<div class="card" style="margin-top:18px"><h3>未命中按天（前 5 个会话）</h3><div id="missDays"></div></div>
<div class="card" style="margin-top:18px"><h3>最贵的 10 个回合</h3><table><thead><tr><th>时间</th><th>会话</th><th>未命中</th><th>输出</th><th>总</th></tr></thead><tbody id="top"></tbody></table></div>
<div class="modal" id="dm"><div class="box"><span class="close" onclick="关详()">✕</span><h2 id="dmTitle"></h2><div id="dmBody"></div></div></div>
<script>
const 主题键='tokenflow-theme';
function 套主题(亮){
  const 根=document.documentElement;
  if(亮) 根.classList.add('light'); else 根.classList.remove('light');
  const b=document.getElementById('theme');
  if(b){ b.textContent = 亮?'日间':'夜间'; b.setAttribute('aria-pressed', 亮?'true':'false'); }
}
try{ 套主题(localStorage.getItem(主题键)==='light') }catch(e){ 套主题(false) }
document.addEventListener('click', function(e){
  const t=e.target;
  if(!t || !t.closest) return;
  if(!t.closest('#theme')) return;
  const 亮=!document.documentElement.classList.contains('light');
  套主题(亮);
  try{ localStorage.setItem(主题键, 亮?'light':'dark') }catch(e){}
}, true);
const 万=n=>n>=1e6?(n/1e6).toFixed(2)+'M':n>=1e4?(n/1e4).toFixed(1)+'w':String(n);
const P=n=>(n*100).toFixed(1)+'%';
let 天=7;
const 颜色=['#6f9bff','#f2a65a','#7fd9a6','#e06c9f','#c9a0ff','#ffd479'];
function 折线图(点们,宽,高,色){
  if(!点们||!点们.length) return '<div class="hint">没有数据</div>';
  const 最大=Math.max(1,...点们.map(p=>p.值));
  const n=点们.length;
  const x=i=>n===1?宽/2:14+(宽-28)*i/(n-1);
  const y=v=>高-10-(高-26)*(v/最大);
  const pts=点们.map((p,i)=>x(i).toFixed(1)+','+y(p.值).toFixed(1)).join(' ');
  const 底=高-10;
  const area='14,'+底+' '+pts+' '+(宽-14)+','+底;
  const 点=点们.map((p,i)=>'<circle cx="'+x(i).toFixed(1)+'" cy="'+y(p.值).toFixed(1)+'" r="2.6" fill="'+色+'"><title>'+p.日+' '+万(p.值)+'</title></circle>').join('');
  return '<svg viewBox="0 0 '+宽+' '+高+'" preserveAspectRatio="none" style="width:100%;height:'+高+'px">'
    +'<polygon points="'+area+'" fill="'+色+'22"/>'
    +'<polyline points="'+pts+'" fill="none" stroke="'+色+'" stroke-width="2"/>'+点+'</svg>';
}
function 饼图(片段,大小){
  片段=[...片段].sort((a,b)=>b.值-a.值);
  const 总=片段.reduce((a,b)=>a+b.值,0)||1;
  let 角=-Math.PI/2, out='';
  const R=大小/2, r=R*0.6, cx=R, cy=R;
  for(let i=0;i<片段.length;i++){
    const p=片段[i], a=角, b=角+p.值/总*Math.PI*2;
    const large=(b-a)>Math.PI?1:0;
    const x1=cx+R*Math.cos(a), y1=cy+R*Math.sin(a), x2=cx+R*Math.cos(b), y2=cy+R*Math.sin(b);
    const x3=cx+r*Math.cos(b), y3=cy+r*Math.sin(b), x4=cx+r*Math.cos(a), y4=cy+r*Math.sin(a);
    out+='<path d="M'+x1.toFixed(1)+' '+y1.toFixed(1)+' A'+R+' '+R+' 0 '+large+' 1 '+x2.toFixed(1)+' '+y2.toFixed(1)
      +' L'+x3.toFixed(1)+' '+y3.toFixed(1)+' A'+r+' '+r+' 0 '+large+' 0 '+x4.toFixed(1)+' '+y4.toFixed(1)+' Z" fill="'+颜色[i%颜色.length]+'">'
      +'<title>'+p.名+' '+万(p.值)+' '+(p.值/总*100).toFixed(1)+'%</title></path>';
    角=b;
  }
  const 图例=片段.map((p,i)=>'<div class="row"><span><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:'+颜色[i%颜色.length]+';margin-right:6px"></i>'+p.名+'</span><span>'+万(p.值)+' · '+(p.值/总*100).toFixed(1)+'%</span></div>').join('');
  return '<div style="display:flex;gap:16px;align-items:center"><svg viewBox="0 0 '+大小+' '+大小+'" style="width:'+大小+'px;height:'+大小+'px;flex:none">'+out+'</svg><div style="flex:1">'+图例+'</div></div>';
}
function 多线图(系列,宽,高){
  const 日们=[...new Set(系列.flatMap(s=>s.点.map(p=>p.日)))].sort();
  if(!日们.length) return '<div class="hint">没有数据</div>';
  const 最大=Math.max(1,...系列.flatMap(s=>s.点.map(p=>p.值)));
  const x=i=>日们.length===1?宽/2:14+(宽-28)*i/(日们.length-1);
  const y=v=>高-10-(高-26)*(v/最大);
  let out='', 图例=[];
  系列.forEach((s,si)=>{
    const 色=颜色[si%颜色.length];
    const m=new Map(s.点.map(p=>[p.日,p.值]));
    const pts=日们.map((d,i)=>x(i).toFixed(1)+','+y(m.get(d)||0).toFixed(1)).join(' ');
    out+='<polyline points="'+pts+'" fill="none" stroke="'+色+'" stroke-width="1.8"/>';
    图例.push('<span style="margin-right:12px;display:inline-block"><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:'+色+';margin-right:4px"></i>'+s.名+'</span>');
  });
  return '<svg viewBox="0 0 '+宽+' '+高+'" preserveAspectRatio="none" style="width:100%;height:'+高+'px">'+out+'</svg><div class="hint">'+图例.join('')+'</div>';
}
async function 拉(){
  const j=await (await fetch('/dsh-token-flow/api?days='+天)).json();
  if(j.错){document.getElementById('sub').textContent=j.错;return;}
  const t=j.合计;
  document.getElementById('sub').textContent=(j.最早?new Date(j.最早).toLocaleString('zh-CN')+' 起 … ':'')
    +'共 '+t.回合+' 回合 · 缓存命中率 '+P(j.命中率)+' · 平均每回合 '+万(j.平均回合)+' token';
  document.getElementById('csv').href='/dsh-token-flow/csv?days='+天;
  document.getElementById('tb').innerHTML=j.行.map(x=>'<tr style="cursor:pointer" data-key="'+x.键+'"><td class="k">'+x.会话+'</td><td>'+x.回合+'</td><td>'+万(x.未命中)+'</td><td>'+万(x.命中)+'</td><td>'+万(x.输出)+'</td><td>'+万(x.总)+'</td><td>'+P(x.命中率)+'</td><td>'+万(x.平均回合)+'</td><td>'+万(x.平均输出)+'</td><td>'+(t.总?(x.总/t.总*100).toFixed(1):'0')+'%</td></tr>').join('')
    +'<tr><td><b>合计</b></td><td><b>'+t.回合+'</b></td><td>'+万(t.未命中)+'</td><td>'+万(t.命中)+'</td><td>'+万(t.输出)+'</td><td><b>'+万(t.总)+'</b></td><td>'+P(j.命中率)+'</td><td>'+万(j.平均回合)+'</td><td>100%</td></tr>';
  document.querySelectorAll('#tb tr[data-key]').forEach(tr=>{tr.onclick=()=>开详(tr.getAttribute('data-key'))});
  const max=Math.max(...j.天.map(x=>x.总),1);
  document.getElementById('days').innerHTML=折线图(j.天.map(x=>({日:x.日,值:x.总})),560,110,'#6f9bff');
  document.getElementById('pie').innerHTML=饼图(j.行.slice(0,6).map(x=>({名:x.会话,值:x.总})),140);
  document.getElementById('pie2').innerHTML=饼图(j.行.slice(0,6).map(x=>({名:x.会话,值:x.实付})),140);
  document.getElementById('multi').innerHTML=多线图((j.会话天||[]).slice(0,6).map(s=>({名:s.会话,点:s.点.map(p=>({日:p.日,值:p.总}))})),560,150);
  document.getElementById('daysHint').textContent=j.天.length?(j.天[0].日+' → '+j.天[j.天.length-1].日+'，最高 '+万(max)):'没有数据';
  const pv=j.峰谷;
  document.getElementById('pv').innerHTML=
    '<div class="row"><span>峰价</span><span>'+pv.峰.回合+' 回合 · '+万(pv.峰.token)+'</span></div>'+
    '<div class="row"><span>谷价</span><span>'+pv.谷.回合+' 回合 · '+万(pv.谷.token)+'</span></div>'+
    '<div class="row"><span>未命中（峰/谷）</span><span>'+万(pv.峰.未命中)+' / '+万(pv.谷.未命中)+'</span></div>'+
    '<div class="row"><span>输出（峰/谷）</span><span>'+万(pv.峰.输出)+' / '+万(pv.谷.输出)+'</span></div>';
  document.getElementById('hv').innerHTML=j.时段.map((x,i)=>x.token?'<div class="row"><span>'+String(i).padStart(2,'0')+':00</span><span>'+万(x.token)+'</span></div>':'').join('');
  document.getElementById('top').innerHTML=(j.最贵||[]).map(x=>'<tr><td>'+new Date(x.t).toLocaleString('zh-CN')+'</td><td class="k">'+x.会话+'</td><td>'+万(x.未命中)+'</td><td>'+万(x.输出)+'</td><td>'+万(x.总)+'</td></tr>').join('');

  // 每个会话的未命中按天：每行一个小柱状，柱高按全表最大值归一
  const md=j.会话天||[];
  document.getElementById('missDays').innerHTML=md.map(s=>{
    const 合=s.点.reduce((n,p)=>n+p.未命中,0);
    return '<div style="display:flex;align-items:center;gap:10px;margin:6px 0"><span style="width:118px;flex:none">'+s.会话+'</span>'
      +'<span style="flex:1">'+折线图(s.点.map(p=>({日:p.日,值:p.未命中})),300,46,'#f2a65a')+'</span>'
      +'<span style="width:62px;text-align:right;flex:none">'+万(合)+'</span></div>';
  }).join('') || '<div class="hint">没有数据</div>';
  const 峰比=pv.峰.未命中+pv.谷.未命中>0?(pv.峰.未命中/(pv.峰.未命中+pv.谷.未命中)*100).toFixed(1)+'%':'—';
  document.getElementById('pv').innerHTML+='<div class="row warn"><span>峰价未命中占比</span><span>'+峰比+'</span></div>';
}
async function 开详(键){
  const j=await (await fetch('/dsh-token-flow/detail?days='+天+'&key='+encodeURIComponent(键))).json();
  if(j.错){alert(j.错);return;}
  document.getElementById('dmTitle').textContent=j.名+' · '+(天===0?'全部':天+' 天');
  const t=j.合计;
  const 峰比=(j.峰谷.峰.未命中+j.峰谷.谷.未命中)>0?(j.峰谷.峰.未命中/(j.峰谷.峰.未命中+j.峰谷.谷.未命中)*100).toFixed(1)+'%':'—';
  let h='<div class="row"><span>回合 / 平均每回合</span><span>'+t.回合+' · '+万(j.平均回合)+'</span></div>'
    +'<div class="row"><span>命中率 / 平均输出</span><span>'+P(j.命中率)+' · '+万(j.平均输出)+'</span></div>'
    +'<div class="row"><span>未命中 / 输出</span><span>'+万(t.未命中)+' / '+万(t.输出)+'</span></div>'
    +'<div class="row warn"><span>峰价未命中占比</span><span>'+峰比+'</span></div>';
  h+='<h3 style="font-size:13px;color:#bdbdbd;margin:14px 0 6px">按天 · 总 token</h3>'+折线图(j.天.map(x=>({日:x.日,值:x.总})),520,90,'#6f9bff');
  h+='<h3 style="font-size:13px;color:#bdbdbd;margin:14px 0 6px">按天 · 未命中</h3>'+折线图(j.天.map(x=>({日:x.日,值:x.未命中})),520,90,'#f2a65a');
  h+='<h3 style="font-size:13px;color:#bdbdbd;margin:14px 0 6px">峰 / 谷 占比</h3>'+饼图([{名:'峰价',值:j.峰谷.峰.token},{名:'谷价',值:j.峰谷.谷.token}],130);
  h+='<h3 style="font-size:13px;color:#bdbdbd;margin:14px 0 6px">实付构成（未命中 / 输出）</h3>'+饼图([{名:'未命中',值:j.合计.未命中},{名:'输出',值:j.合计.输出}],130);
  h+='<h3 style="font-size:13px;color:#bdbdbd;margin:14px 0 6px">每回合未命中</h3>'+折线图(j.天.map(x=>({日:x.日,值:x.回合?Math.round(x.未命中/x.回合):0})),520,80,'#7fd9a6');
  h+='<h3 style="font-size:13px;color:#bdbdbd;margin:14px 0 6px">按小时</h3>'
    +j.时段.map((x,i)=>x.token?'<div class="row"><span>'+String(i).padStart(2,'0')+':00</span><span>'+万(x.token)+'</span></div>':'').join('');
  h+='<h3 style="font-size:13px;color:#bdbdbd;margin:14px 0 6px">模型</h3>'
    +j.模型.map(x=>'<div class="row"><span>'+x.模型+'</span><span>'+万(x.token)+'</span></div>').join('');
  h+='<h3 style="font-size:13px;color:#bdbdbd;margin:14px 0 6px">最贵的回合</h3><table><thead><tr><th>时间</th><th>未命中</th><th>输出</th><th>总</th></tr></thead><tbody>'
    +j.最贵.map(x=>'<tr><td>'+new Date(x.t).toLocaleString('zh-CN')+'</td><td>'+万(x.未命中)+'</td><td>'+万(x.输出)+'</td><td>'+万(x.总)+'</td></tr>').join('')+'</tbody></table>';
  document.getElementById('dmBody').innerHTML=h;
  document.getElementById('dm').classList.add('on');
}
function 关详(){document.getElementById('dm').classList.remove('on')}
document.getElementById('dm').onclick=(e)=>{if(e.target.id==='dm')关详()};
document.querySelectorAll('.bar button').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('.bar button').forEach(x=>x.classList.remove('on'));
  b.classList.add('on');天=Number(b.dataset.d);拉();
});
拉();
</script></body></html>`

function 转CSV(结果) {
  const 头 = ['会话', '回合', '命中', '未命中', '写入', '输出', '总token', '命中率']
  const 行 = 结果.行.map((r) => [r.会话, r.回合, r.命中, r.未命中, r.写入, r.输出, r.总, (r.命中率 * 100).toFixed(1) + '%'])
  行.push(['合计', 结果.合计.回合, 结果.合计.命中, 结果.合计.未命中, 结果.合计.写入, 结果.合计.输出, 结果.合计.总, (结果.命中率 * 100).toFixed(1) + '%'])
  return [头, ...行].map((cols) => cols.map((c) => {
    const s = String(c)
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }).join(',')).join('\n')
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-token-flow',
    handler: async (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(页面)
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-token-flow/api',
    handler: async (req, res) => {
      try {
        const u = new URL(req.url || '/', 'http://x')
        const 天 = Math.max(0, Number(u.searchParams.get('days') || 7) || 0)
        const 起 = 天 === 0 ? 0 : Date.now() - 天 * 24 * 3600 * 1000
        const 结果 = 聚合(起, await 群名表())
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(结果))
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ 错: e?.message ?? String(e) }))
      }
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-token-flow/csv',
    handler: async (req, res) => {
      try {
        const u = new URL(req.url || '/', 'http://x')
        const 天 = Math.max(0, Number(u.searchParams.get('days') || 7) || 0)
        const 起 = 天 === 0 ? 0 : Date.now() - 天 * 24 * 3600 * 1000
        const 结果 = 聚合(起, await 群名表())
        res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="token-flow-${天 || 'all'}d.csv"`,
          'cache-control': 'no-store',
        })
        res.end('\ufeff' + 转CSV(结果))
      } catch (e) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(String(e?.message ?? e))
      }
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-token-flow/detail',
    handler: async (req, res) => {
      try {
        const u = new URL(req.url || '/', 'http://x')
        const 键 = String(u.searchParams.get('key') || '')
        const 天 = Math.max(0, Number(u.searchParams.get('days') || 7) || 0)
        const 起 = 天 === 0 ? 0 : Date.now() - 天 * 24 * 3600 * 1000
        const 结果 = 键 ? 聚合详(键, 起, await 群名表()) : { 错: '缺少 key' }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(结果))
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ 错: e?.message ?? String(e) }))
      }
    },
  }))
}
