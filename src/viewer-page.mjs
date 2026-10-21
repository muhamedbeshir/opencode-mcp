const STYLE = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1c1c1e;--mut:#6b6b70;--card:#f4f4f6;--ok:#1a7f37;--bad:#c62828;--run:#0b6bcb}
@media(prefers-color-scheme:dark){:root{--bg:#161618;--fg:#ececf0;--mut:#9a9aa2;--card:#222226;--ok:#4ac26b;--bad:#ff6b6b;--run:#6cb2ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:16px}h1{font-size:18px;margin:0 0 4px}
.mut{color:var(--mut);font-size:13px}.bar{display:flex;gap:10px;align-items:center;margin:8px 0 16px}
.dot{width:10px;height:10px;border-radius:50%;background:var(--mut)}.dot.running{background:var(--run);animation:p 1s infinite}
.dot.succeeded{background:var(--ok)}.dot.failed{background:var(--bad)}@keyframes p{50%{opacity:.3}}
.msg{background:var(--card);border-radius:10px;padding:10px 14px;margin:10px 0;white-space:pre-wrap;word-break:break-word}
.msg.user{border-inline-start:3px solid var(--run)}.tool{font:13px ui-monospace,monospace;color:var(--mut);margin:4px 0;white-space:pre-wrap;word-break:break-all}
.warn{color:var(--bad);font-weight:600}a{color:var(--run)}li{margin:6px 0}
`;

const shell = (title, body, script = "") =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${STYLE}</style></head><body><main>${body}</main>${script ? `<script>${script}</script>` : ""}</body></html>`;

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function indexPage(base, sessions) {
  const rows = sessions.map((s) => `<li><a href="${base}/s/${esc(s.id)}">${esc(s.title || s.id)}</a> <span class="mut">${esc(s.directory)}</span></li>`).join("");
  return shell("OpenCode sessions", `<h1>OpenCode sessions</h1><p class="mut">Only the project folders you authorized are listed.</p><ul>${rows || "<li class='mut'>No sessions yet.</li>"}</ul>`);
}

const CLIENT = `
var base=location.pathname;var box=document.getElementById("log");var dot=document.getElementById("dot");var label=document.getElementById("state");
var current=null;
function add(cls,text){var d=document.createElement("div");d.className=cls;d.dir="auto";d.textContent=text;box.appendChild(d);scrollTo(0,document.body.scrollHeight);return d}
function state(s,t){dot.className="dot "+s;label.textContent=t}
function onEvent(e){var d=e.data||{};
 if(e.type==="session.execution.started"){state("running","Working...");current=null}
 else if(e.type==="session.execution.succeeded"){state("succeeded","Finished")}
 else if(e.type==="session.execution.failed"){state("failed","Failed");add("msg warn",d.message||d.error||"The turn failed")}
 else if(e.type==="session.text.delta"){if(!current)current=add("msg","");current.textContent+=d.delta||""}
 else if(e.type==="session.text.ended"){current=null}
 else if(e.type==="session.tool.called"){add("tool","> "+(d.name||"tool")+" "+JSON.stringify(d.input||{}).slice(0,300))}
 else if(/permission/.test(e.type)){add("msg warn","Waiting for permission: "+(d.permission||d.title||e.type)+" (answer it from your assistant with opencode_permissions)")}}
fetch(base+"/history").then(function(r){return r.json()}).then(function(h){
 (h.messages||[]).forEach(function(m){add(m.type==="user"?"msg user":"msg",m.text||"")});
 if(h.running)state("running","Working...");else state("","Idle");
 var es=new EventSource(base+"/events");es.onmessage=function(m){try{onEvent(JSON.parse(m.data))}catch(x){}};
 es.onerror=function(){label.textContent="Reconnecting..."};
});
`;

export function sessionPage(base, session) {
  const head = `<h1>${esc(session.title || session.id)}</h1><div class="mut">${esc(session.directory)} &middot; ${esc(session.id)}</div><div class="bar"><span id="dot" class="dot"></span><span id="state" class="mut">Loading...</span></div><div id="log"></div>`;
  return shell("OpenCode live", head, CLIENT);
}
