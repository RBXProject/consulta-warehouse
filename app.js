const CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbzlNhIKt3OKPFFKGxkjkEhgD4rfruNgcsoG4pl6tc89GCKqBaPJs_rZ88JLotbj94Ug/exec',
  SHEET_ID: '10WtS_t2aa4JTlxW0d3VDy3a3w3eXSdJ2ulwQeFp6Y3o',
  SHEET_NAME: 'BASE_ESTOQUE',
  CHUNK_SIZE: 2000,
  RENDER_BATCH: 50
};

const DB_NAME = 'GMINING_WAREHOUSE_DB';
const DB_VERSION = 1;
const STORE_ITEMS = 'items';
const STORE_META = 'meta';
let db;
let localItems = [];
let deferredPrompt = null;
let currentResults = [];
let renderedCount = 0;

const $ = id => document.getElementById(id);
const els = {
  searchInput: $('searchInput'), searchBtn: $('searchBtn'), syncBtn: $('syncBtn'), results: $('results'),
  itemCount: $('itemCount'), resultCount: $('resultCount'), syncInfo: $('syncInfo'), message: $('message'),
  progressBox: $('progressBox'), connectionStatus: $('connectionStatus'), onlineDot: $('onlineDot'), onlineText: $('onlineText')
};

function normalizeText(value){ return String(value||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim(); }
function toNumber(value){ if(typeof value==='number') return value; const n=Number(String(value||'').replace(/\./g,'').replace(',','.').replace(/[^0-9.-]/g,'')); return Number.isFinite(n)?n:0; }
function moneyBR(value){ return toNumber(value).toLocaleString('pt-BR',{style:'currency',currency:'BRL'}); }
function dateBR(ts){ if(!ts) return '-'; return new Date(ts).toLocaleString('pt-BR'); }

function jsonp(action, params={}){
  return new Promise((resolve,reject)=>{
    const cb='cb_'+Date.now()+'_'+Math.random().toString(36).slice(2);
    const url = new URL(CONFIG.API_URL);
    url.searchParams.set('action', action);
    url.searchParams.set('callback', cb);
    Object.entries(params).forEach(([k,v])=>url.searchParams.set(k,v));
    const script=document.createElement('script');
    const timer=setTimeout(()=>{ cleanup(); reject(new Error('Tempo esgotado na conexão com a API.')); }, 90000);
    function cleanup(){ clearTimeout(timer); delete window[cb]; script.remove(); }
    window[cb]=(data)=>{ cleanup(); data && data.ok === false ? reject(new Error(data.error||'Erro na API')) : resolve(data); };
    script.onerror=()=>{ cleanup(); reject(new Error('Falha ao carregar API.')); };
    script.src=url.toString();
    document.body.appendChild(script);
  });
}

function openDB(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded=e=>{
      const d=e.target.result;
      if(!d.objectStoreNames.contains(STORE_ITEMS)){
        const store=d.createObjectStore(STORE_ITEMS,{keyPath:'codigo'});
        store.createIndex('search','search',{unique:false});
      }
      if(!d.objectStoreNames.contains(STORE_META)) d.createObjectStore(STORE_META,{keyPath:'key'});
    };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}
function tx(store, mode='readonly'){ return db.transaction(store,mode).objectStore(store); }
function getMeta(key){ return new Promise(res=>{ const r=tx(STORE_META).get(key); r.onsuccess=()=>res(r.result?.value); r.onerror=()=>res(null); }); }
function setMeta(key,value){ return new Promise((res,rej)=>{ const r=tx(STORE_META,'readwrite').put({key,value}); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); }); }
function clearItems(){ return new Promise((res,rej)=>{ const r=tx(STORE_ITEMS,'readwrite').clear(); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); }); }
function putItems(items){ return new Promise((resolve,reject)=>{ const t=db.transaction(STORE_ITEMS,'readwrite'); const s=t.objectStore(STORE_ITEMS); items.forEach(item=>s.put(item)); t.oncomplete=resolve; t.onerror=()=>reject(t.error); }); }
function getAllItems(){ return new Promise((resolve,reject)=>{ const r=tx(STORE_ITEMS).getAll(); r.onsuccess=()=>resolve(r.result||[]); r.onerror=()=>reject(r.error); }); }

function prepareItem(item){
  const livre=toNumber(item.estoqueLivre), minimo=toNumber(item.estoqueMinimo), ponto=toNumber(item.ponto), maximo=toNumber(item.estoqueMaximo);
  let status='Sem parâmetro', statusClass='neutral', statusEmoji='';
  if(minimo===0 && ponto===0 && maximo===0){ status='Sem parâmetro'; statusClass='neutral'; }
  else if(maximo>0 && livre>maximo){ status='Acima do máximo'; statusClass='excesso'; statusEmoji='⚠️'; }
  else if(minimo>0 && livre<minimo){ status='Abaixo do mínimo'; statusClass='baixo'; statusEmoji='🔴'; }
  else if(ponto>0 && livre<=ponto){ status='Ponto de atenção'; statusClass='atencao'; statusEmoji='🟡'; }
  else { status='Estoque normal'; statusClass='normal'; statusEmoji='🟢'; }
  return {...item, estoqueLivre:livre, estoqueMinimo:minimo, ponto, estoqueMaximo:maximo, valorTotal:toNumber(item.valorTotal), status, statusClass, statusEmoji,
    search: normalizeText(`${item.codigo} ${item.descricao} ${item.referencia} ${item.descricaoLonga} ${item.posDeposito}`)};
}

async function refreshLocalCache(){
  localItems = await getAllItems();
  const updatedAt = await getMeta('updatedAt');
  const revision = await getMeta('revision');
  els.itemCount.textContent = localItems.length.toLocaleString('pt-BR');
  els.syncInfo.textContent = `Última atualização local: ${dateBR(updatedAt)}`;
  if(revision) els.syncInfo.title = `Revisão: ${revision}`;
}

function setConnection(){
  const online=navigator.onLine;
  els.connectionStatus.textContent=online?'Online':'Offline';
  els.connectionStatus.className='connection '+(online?'online':'offline');
  els.onlineText.textContent=online?'Online':'Offline';
  els.onlineDot.style.background=online?'#35b738':'#ffc107';
}
function showProgress(msg){ els.progressBox.classList.remove('hidden'); els.progressBox.textContent=msg; }
function hideProgress(){ els.progressBox.classList.add('hidden'); els.progressBox.textContent=''; }
function showMessage(msg){ els.message.classList.remove('hidden'); els.message.textContent=msg; }
function hideMessage(){ els.message.classList.add('hidden'); }

async function syncBase(force=false){
  if(!navigator.onLine){ showMessage('Modo offline. A pesquisa usará a última base sincronizada no aparelho.'); return; }
  try{
    els.syncBtn.disabled=true;
    showProgress('Verificando atualizações...');
    const meta=await jsonp('meta',{sheetId:CONFIG.SHEET_ID,sheetName:CONFIG.SHEET_NAME});
    const localRevision=await getMeta('revision');
    if(!force && localRevision && String(localRevision)===String(meta.revision) && localItems.length===meta.count){
      showProgress('Base local já está atualizada.');
      setTimeout(hideProgress,1500); return;
    }
    showProgress(`Sincronizando base offline... 0 de ${meta.count.toLocaleString('pt-BR')} itens`);
    await clearItems();
    let downloaded=0;
    for(let offset=0; offset<meta.count; offset+=CONFIG.CHUNK_SIZE){
      const chunk=await jsonp('chunk',{sheetId:CONFIG.SHEET_ID,sheetName:CONFIG.SHEET_NAME,offset,limit:CONFIG.CHUNK_SIZE});
      const prepared=(chunk.items||[]).map(prepareItem);
      await putItems(prepared);
      downloaded += prepared.length;
      showProgress(`Sincronizando base offline... ${downloaded.toLocaleString('pt-BR')} de ${meta.count.toLocaleString('pt-BR')} itens`);
    }
    await setMeta('revision', meta.revision);
    await setMeta('updatedAt', Date.now());
    await refreshLocalCache();
    showProgress(`Base sincronizada com sucesso: ${localItems.length.toLocaleString('pt-BR')} itens.`);
    setTimeout(hideProgress,2500);
  }catch(err){
    showProgress('Erro ao sincronizar: '+err.message);
  }finally{ els.syncBtn.disabled=false; }
}

function createCard(item){
  const card=document.createElement('article');
  card.className='card '+item.statusClass;
  card.innerHTML=`
    <div class="codigo">${escapeHtml(item.codigo||'-')}</div>
    <div class="descricao">${escapeHtml(item.descricao||'-')}</div>
    <div class="grid">
      <div><div class="label">Referência</div><div class="value">${escapeHtml(item.referencia||'-')}</div></div>
      <div><div class="label">Tipo MRP</div><div class="value">${escapeHtml(item.tipoMrp||'-')}</div></div>
      <div><div class="label">Estoque Livre</div><div class="value">${item.estoqueLivre}</div></div>
      <div><div class="label">Estoque Mínimo</div><div class="value">${item.estoqueMinimo}</div></div>
      <div><div class="label">Ponto Ressuprimento</div><div class="value">${item.ponto}</div></div>
      <div><div class="label">Estoque Máximo</div><div class="value">${item.estoqueMaximo}</div></div>
      <div><div class="label">Posição Depósito</div><div class="value">${escapeHtml(item.posDeposito||'-')}</div></div>
      <div><div class="label">Valor Total</div><div class="value">${moneyBR(item.valorTotal)}</div></div>
    </div>
    <div class="longa">Descrição Longa: ${escapeHtml(item.descricaoLonga||'-')}</div>
    <div class="status ${item.statusClass}"><span class="emoji">${item.statusEmoji}</span>${escapeHtml(item.status)}</div>`;
  return card;
}

function renderNextBatch(){
  const oldBtn=document.getElementById('loadMoreBtn');
  if(oldBtn) oldBtn.remove();

  const next=currentResults.slice(renderedCount, renderedCount + CONFIG.RENDER_BATCH);
  const frag=document.createDocumentFragment();
  next.forEach(item=>frag.appendChild(createCard(item)));
  els.results.appendChild(frag);
  renderedCount += next.length;

  if(renderedCount < currentResults.length){
    const btn=document.createElement('button');
    btn.id='loadMoreBtn';
    btn.className='load-more-btn';
    btn.textContent=`Carregar mais (${renderedCount.toLocaleString('pt-BR')} de ${currentResults.length.toLocaleString('pt-BR')})`;
    btn.addEventListener('click', renderNextBatch);
    els.results.appendChild(btn);
  }
}

function renderResults(items){
  els.results.innerHTML='';
  currentResults = items || [];
  renderedCount = 0;
  els.resultCount.textContent=currentResults.length.toLocaleString('pt-BR');
  if(!currentResults.length){ showMessage('Nenhum material encontrado.'); return; }
  hideMessage();
  renderNextBatch();
}
function escapeHtml(value){ return String(value??'').replace(/[&<>'"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function search(){
  const q=normalizeText(els.searchInput.value);
  if(!q){ els.results.innerHTML=''; els.resultCount.textContent='0'; showMessage('Digite um código, descrição ou referência para consultar o estoque.'); return; }
  const terms=q.split(/\s+/).filter(Boolean);
  const found=localItems.filter(item=>terms.every(t=>item.search.includes(t)));
  renderResults(found);
}

async function boot(){
  setConnection();
  window.addEventListener('online',()=>{ setConnection(); syncBase(false); });
  window.addEventListener('offline',setConnection);
  if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
  db=await openDB();
  await refreshLocalCache();
  if(localItems.length===0) showMessage('Primeiro acesso: conecte à internet e toque em Atualizar para salvar a base offline.');
  else showMessage('Digite um código, descrição ou referência para consultar o estoque.');
  els.searchBtn.addEventListener('click',search);
  els.searchInput.addEventListener('input',()=>{ clearTimeout(window.__st); window.__st=setTimeout(search,180); });
  els.syncBtn.addEventListener('click',()=>syncBase(true));
  if(navigator.onLine) syncBase(false);
}
boot();
