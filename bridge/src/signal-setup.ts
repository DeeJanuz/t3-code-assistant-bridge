/** Static local-only setup UI. All external data is inserted with textContent. */
export function signalSetupHtml(nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Signal setup · Faceclaw Bridge</title>
<style nonce="${nonce}">body{font:16px system-ui;max-width:880px;margin:40px auto;padding:0 24px;color:#e5e9ef;background:#14181e}h1,h2{color:white}section{border:1px solid #434b59;padding:20px;margin:18px 0;border-radius:12px}input,select,button{font:inherit;padding:9px;margin:4px;background:#202832;color:#fff;border:1px solid #64748b;border-radius:5px}button{cursor:pointer}label{display:block;margin:10px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}#error{color:#ffaaa5}small{color:#aeb8c5}.row{padding:12px 0;border-bottom:1px solid #434b59}img{max-width:100%}button:focus-visible,input:focus-visible{outline:3px solid #8dcaff}</style></head><body>
<h1>Signal on Faceclaw</h1><p>Link one Signal account, pair the glasses application, and control assistant access.</p><p id="error" role="alert"></p>
<section id="login"><h2>Owner sign-in</h2><p>Enter this bridge's owner credential (BRIDGE_TOKEN). It stays in memory and is cleared after sign-in. Do not use a T3 provider token.</p><label>Owner credential <input id="owner" type="password" autocomplete="off"></label><button id="signin">Sign in</button></section>
<main id="main" hidden><button id="refresh">Refresh</button><button id="logout">Sign out</button><pre id="status" aria-live="polite"></pre>
<section><h2>1. Link your Signal account</h2><p>Keep the bridge computer online. In the official Signal app, open Settings → Linked devices and scan the QR code.</p><button id="link">Link Signal</button><button id="adopt">Recover a completed link</button><div id="linkcode"></div><p>History starts after linking. Attachments, calls, and voice messages are outside this release.</p><p>Timed messages use an earlier expiry measured from their sent timestamp because signal-cli omits the original timer start. Delayed timed messages can expire before you read them here. Sending requires fresh recipient timer metadata.</p></section>
<section><h2>2. Pair the glasses application</h2><p>Install the Signal APK normally. Select it in Faceclaw settings, choose one host, then enter the private HTTPS bridge origin and this one-use pairing code. Never enter the owner credential on the phone.</p><button id="pair">Create two-minute pairing code</button><pre id="paircode"></pre><p>Enable Signal notification forwarding and optionally suppress official Signal alerts on the glasses in Faceclaw settings. Phone notifications remain unchanged.</p></section>
<section><h2>History and previews</h2><label>Retention days <input id="days" type="number" min="1" max="365" value="30"></label><label>Glasses preview <select id="preview"><option value="message">Sender and message</option><option value="sender">Sender only</option></select></label><button id="save">Save settings</button><p>Expired or deleted messages also remove related drafts. Storage is encrypted with an owner-only local key. Exclude the Signal data directory from backups and use full-disk encryption.</p></section>
<section><h2>Assistant access</h2><p>To enable access, select conversations and create a separate credential. Access permits reading and drafting only. Every send requires a fresh review here. Content copied into assistant conversations follows that system's retention; revocation cannot retract it.</p><button id="recipients">Refresh contacts and groups</button><div id="conversations"></div><button id="grant">Grant selected conversations</button><pre id="assistanttoken"></pre><div id="drafts"></div><div id="review"></div></section>
<section><h2>Connected credentials</h2><div id="credentials"></div><p>Revocation takes effect immediately for future access. Already dispatched messages cannot be recalled.</p></section>
<section><h2>Remove this integration</h2><p>This deletes this bridge's local Signal account keys, credentials, history, drafts, and send ledger. Remove Faceclaw Bridge from Linked devices in the official Signal app too. Your primary Signal account is not deleted.</p><button id="reset">Delete local Signal data</button></section></main><script nonce="${nonce}">
let token='', state=null, settingsDirty=false, activeReview=null; const el=id=>document.getElementById(id);
async function api(method,params={}){const r=await fetch('/v1/signal/admin',{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify({method,params})});const v=await r.json();if(!r.ok){if(r.status===401&&token){token='';state=null;el('main').hidden=true;el('login').hidden=false;for(const name of ['status','linkcode','paircode','assistanttoken','drafts','review','credentials','conversations'])el(name).replaceChildren()}throw Error(v.error?.message||'Request failed')};return v}
function button(label,action){const b=document.createElement('button');b.textContent=label;b.onclick=()=>run(action);return b}
function run(action){el('error').textContent='';Promise.resolve().then(action).catch(e=>el('error').textContent=e.message)}
function show(id,value){el(id).textContent=typeof value==='string'?value:JSON.stringify(value,null,2)}
async function refresh(){
  const previous=state;
  try{state=await api('status')}catch(error){show('status','Bridge unavailable. Connection status cannot be confirmed. Your unsaved settings are preserved.');throw error}
  show('status',(state.accountId?'Linked account: '+state.accountId:'No Signal account linked.')+'\\n'+(state.ready?'Connected and receiving.':'Connection: '+state.health)+(state.link?.status==='waiting'?'\\nWaiting for the phone to scan the link.':''));
  if(!settingsDirty){el('days').value=state.retentionDays;el('preview').value=state.preview}
  if(JSON.stringify(previous?.conversations)!==JSON.stringify(state.conversations)){
    const selected=new Set(Array.from(el('conversations').querySelectorAll('input:checked')).map(i=>i.value));
    el('conversations').replaceChildren();
    for(const c of state.conversations){const label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.value=c.id;check.checked=selected.has(c.id);label.append(check,document.createTextNode(c.title+' ('+c.kind+')'));el('conversations').append(label)}
  }
  if(JSON.stringify(previous?.credentials)!==JSON.stringify(state.credentials)){
    el('credentials').replaceChildren();
    for(const c of state.credentials){const row=document.createElement('div');row.className='row';row.append(document.createTextNode(c.kind+' · '+c.id+' '),button('Revoke',async()=>{await api('credential.revoke',{credentialId:c.id});await refresh()}));el('credentials').append(row)}
  }
  if(activeReview&&!state.drafts.some(d=>d.owner===activeReview.owner&&d.conversationId===activeReview.conversationId&&d.text===activeReview.text)){activeReview=null;el('review').replaceChildren()}
  if(JSON.stringify(previous?.drafts)!==JSON.stringify(state.drafts)){
    el('drafts').replaceChildren();
    for(const d of state.drafts){
      const row=document.createElement('div');row.className='row';row.dataset.expiresAt=String(d.expiresAt);
      row.append(document.createTextNode((state.conversations.find(c=>c.id===d.conversationId)?.title||'Conversation')+': '+d.text+' '),button('Review draft',async()=>{
        const r=await api('assistant.review',{credentialId:d.owner,conversationId:d.conversationId});activeReview={owner:d.owner,conversationId:d.conversationId,text:r.text};el('review').replaceChildren();
        const p=document.createElement('pre');p.textContent='Account: '+r.accountId+'\\nRecipient: '+(state.conversations.find(c=>c.id===r.conversationId)?.title||r.conversationId)+'\\n\\n'+r.text;
        const op=crypto.randomUUID();setTimeout(()=>{if(activeReview?.owner===d.owner&&activeReview?.text===r.text){activeReview=null;el('review').replaceChildren()}},Math.max(0,r.expiresAt-Date.now()));
        el('review').append(p,button('Send this exact message',async()=>{const result=await api('assistant.send',{reviewId:r.reviewId,operationId:op});activeReview=null;show('review',result.operation.status==='sent'?'Message sent.':result.operation.status==='unknown'?'Send outcome is unknown. Do not retry this message.':'Send is pending.');await refresh()}),button('Cancel',()=>{activeReview=null;el('review').replaceChildren()}));
      }));el('drafts').append(row);
    }
  }
}
el('signin').onclick=()=>run(async()=>{const ownerToken=el('owner').value;el('owner').value='';const r=await api('login',{ownerToken});token=r.token;el('login').hidden=true;el('main').hidden=false;await refresh()});
el('logout').onclick=()=>run(async()=>{await api('logout');token='';location.reload()});el('refresh').onclick=()=>run(refresh);
el('link').onclick=()=>run(async()=>{const r=await api('link.start');el('linkcode').replaceChildren();const image=document.createElement('img');image.src=r.qr;image.alt='Scan to link Faceclaw Bridge with Signal';el('linkcode').append(image);setTimeout(()=>el('linkcode').replaceChildren(),Math.max(0,r.expiresAt-Date.now()));await refresh()});
el('adopt').onclick=()=>run(async()=>{if(!confirm('Adopt the single linked account in this dedicated Signal directory?'))return;await api('account.adopt',{confirm:'ADOPT LINKED ACCOUNT'});await refresh()});
el('pair').onclick=()=>run(async()=>{const r=await api('pairing.create');show('paircode',r.code);setTimeout(()=>show('paircode','Pairing code expired.'),Math.max(0,r.expiresAt-Date.now()))});
el('save').onclick=()=>run(async()=>{await api('settings',{retentionDays:Number(el('days').value),preview:el('preview').value});settingsDirty=false;await refresh()});
el('recipients').onclick=()=>run(async()=>{await api('recipients.refresh');await refresh()});
el('grant').onclick=()=>run(async()=>{const conversations=Array.from(el('conversations').querySelectorAll('input:checked')).map(i=>i.value);const r=await api('assistant.grant',{conversations});show('assistanttoken','Store privately in the assistant integration. Shown once:\\n'+r.token);await refresh()});
el('reset').onclick=()=>run(async()=>{if(!state.accountId||!confirm('Delete all local Signal data and credentials for '+state.accountId+'? This cannot be undone.'))return;await api('account.reset',{accountId:state.accountId,confirm:'DELETE LOCAL SIGNAL DATA'});el('review').replaceChildren();el('paircode').replaceChildren();el('assistanttoken').replaceChildren();await refresh()});
el('days').oninput=()=>{settingsDirty=true};el('preview').onchange=()=>{settingsDirty=true};
setInterval(()=>{if(token)run(refresh)},5000);
setInterval(()=>{for(const row of document.querySelectorAll('[data-expires-at]'))if(Number(row.dataset.expiresAt)<=Date.now())row.remove()},250);
</script></body></html>`;
}
