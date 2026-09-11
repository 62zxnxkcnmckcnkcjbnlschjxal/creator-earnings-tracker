function pushNow(){
  if(!cloudHost) return;
  // Pages Functions 同域名，直接相对路径，不用写外部worker域名
  return fetch('/api/state',{
    method:'PUT',
    body:JSON.stringify(state),
    headers:{'Content-Type':'application/json'}
  })
  .then(function(r){
    if(r.ok){ setSync('cloud'); }
    else { setSync('error'); }
  })
  .catch(function(){ setSync('local'); });
}

function pullCloud(){
  if(!cloudHost){ setSync('local'); return; }
  setSync('syncing');
  fetch('/api/state',{cache:'no-store'})
    .then(function(r){ if(!r.ok) throw 0; return r.json(); })
    .then(function(d){
      d=normalizeCloud(d);
      if(!d.activities.length && state.activities.length){ return pushNow(); }
      if(d.t>=(state.t||0)){
        state=d; saveLocalOnly(); renderAll(); setSync('cloud');
      } else {
        return pushNow();
      }
    })
    .catch(function(){ setSync('local'); });
}
