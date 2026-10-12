'use strict';
const cfg=window.NC_CONFIG;
const db=window.supabase.createClient(cfg.supabaseUrl,cfg.supabaseKey);
const $=id=>document.getElementById(id);
let user,neighborhood,membership,households=[],map,markers=[],generation=0;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function notice(message,error=false){$('notice').textContent=message;$('notice').classList.toggle('error',error);}
function checked(result){if(result.error)throw result.error;return result.data;}
async function run(fn){try{await fn();}catch(e){notice(e.message||'Something went wrong. Please try again.',true);}}
function show(id,visible){$(id).hidden=!visible;}
function view(id){['browse','profile','admin'].forEach(x=>show(x,x===id));document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===id));}
async function load(){
 const version=++generation;
 const session=checked(await db.auth.getSession());user=session.session?.user;
 ['auth','join','pending','directory'].forEach(x=>show(x,false));show('signout',!!user);
 if(!user){households=[];membership=null;markers.forEach(m=>m.map=null);markers=[];$('households').replaceChildren();$('detail').replaceChildren();$('myphotos').replaceChildren();$('requests').replaceChildren();show('detail',false);if(!$('recovery').hidden)return;show('auth',true);return;}
 neighborhood=checked(await db.from('neighborhoods').select('*').eq('slug',cfg.neighborhoodSlug).single());
 membership=checked(await db.from('memberships').select('*').eq('user_id',user.id).eq('neighborhood_id',neighborhood.id).maybeSingle());
 if(version!==generation)return;
 if(!membership){
  const request=checked(await db.from('access_requests').select('status').eq('user_id',user.id).eq('neighborhood_id',neighborhood.id).maybeSingle());
  show(request?'pending':'join',true);
  if(request?.status==='rejected')$('pending').innerHTML='<h2>Request reviewed</h2><p>Your request was not approved. Contact the neighborhood administrator to correct or discuss your address.</p>';
  return;
 }
 households=checked(await db.from('households').select('*').eq('neighborhood_id',neighborhood.id).order('display_name'));
 if(version!==generation)return;
 show('directory',true);show('admintab',membership.role==='admin');view('browse');render();fillProfile();
 await loadMap();await loadMyPhotos();if(membership.role==='admin')await loadRequests();
}
function render(){
 const q=$('search').value.toLowerCase();const visible=households.filter(h=>[h.display_name,h.residents,h.address,h.interests].join(' ').toLowerCase().includes(q));
 $('count').textContent=`${households.length} approved household${households.length===1?'':'s'} · Visible to Burr Oaks residents`;
 $('households').innerHTML=visible.length?visible.map(h=>`<button class="card" data-household="${h.id}"><h3>${esc(h.display_name)}</h3><p>${esc(h.address)}</p>${h.interests?`<span class="badge">${esc(h.interests)}</span>`:''}</button>`).join(''):'<div class="panel"><h3>No households found</h3><p>Try another search, or invite neighbors once setup is complete.</p></div>';
 $('households').querySelectorAll('[data-household]').forEach(b=>b.onclick=()=>run(()=>detail(b.dataset.household)));
 if(map)drawMarkers(visible);
}
let mapsPromise;
async function loadMap(){
 if(!mapsPromise)mapsPromise=new Promise((resolve,reject)=>{window.ncMapsReady=resolve;window.gm_authFailure=()=>{notice('Google Maps could not authorize this website. Check billing, API enablement, and website restrictions.',true);};const s=document.createElement('script');s.src=`https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(cfg.googleMapsKey)}&libraries=marker&loading=async&callback=ncMapsReady`;s.onerror=()=>{mapsPromise=null;reject(new Error('Map could not load. Directory cards still work.'));};document.head.append(s);});
 try{await mapsPromise;if(!map)map=new google.maps.Map($('map'),{center:cfg.center,zoom:15,mapId:cfg.mapId,mapTypeControl:true,streetViewControl:false});render();}catch(e){notice(e.message,true);}
}
function drawMarkers(rows){markers.forEach(m=>m.map=null);markers=rows.map(h=>{const m=new google.maps.marker.AdvancedMarkerElement({map,position:{lat:h.latitude,lng:h.longitude},title:h.display_name});m.addListener('click',()=>run(()=>detail(h.id)));return m;});if(rows.length){const bounds=new google.maps.LatLngBounds();rows.forEach(h=>bounds.extend({lat:h.latitude,lng:h.longitude}));map.fitBounds(bounds);google.maps.event.addListenerOnce(map,'idle',()=>{if(map.getZoom()>17)map.setZoom(17);});}}
async function photoList(id){return checked(await db.storage.from('household-photos').list(id,{limit:100,sortBy:{column:'name',order:'asc'}})).filter(f=>f.id);}
async function photoUrl(path){return checked(await db.storage.from('household-photos').createSignedUrl(path,300)).signedUrl;}
async function detail(id){
 const version=generation;const h=households.find(x=>x.id===id);if(!h)return;
 const files=await photoList(id);const urls=await Promise.all(files.map(f=>photoUrl(`${id}/${f.name}`)));
 if(version!==generation||!user)return;
 $('detail').innerHTML=`<h2>${esc(h.display_name)}</h2><p>${esc(h.address)}</p><p>${esc(h.residents)}</p><p>${esc(h.bio)}</p>${h.interests?`<p><strong>Interests:</strong> ${esc(h.interests)}</p>`:''}${h.email?`<p><strong>Email:</strong> ${esc(h.email)}</p>`:''}${h.phone?`<p><strong>Phone:</strong> ${esc(h.phone)}</p>`:''}<div class="photos">${urls.map(url=>`<figure><img src="${esc(url)}" alt="Household photo" loading="lazy"></figure>`).join('')}</div><p><a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(h.latitude+','+h.longitude)}">Open in Google Maps</a></p><button id="closedetail">Close profile</button>`;
 show('detail',true);$('closedetail').onclick=()=>show('detail',false);$('detail').scrollIntoView({behavior:'smooth',block:'start'});
}
function fillProfile(){const h=households.find(h=>h.id===membership.household_id);if(!h)return;$('myaddress').textContent=h.address;['display_name','residents','email','phone','interests','bio'].forEach(k=>$('profileform').elements[k].value=h[k]||'');}
async function loadMyPhotos(){const id=membership.household_id;const version=generation;const files=await photoList(id);const urls=await Promise.all(files.map(f=>photoUrl(`${id}/${f.name}`)));if(version!==generation)return;
 $('myphotos').innerHTML=files.map((f,i)=>`<figure><img src="${esc(urls[i])}" alt="Your household photo ${i+1}"><button data-delete="${esc(f.name)}">Delete photo</button></figure>`).join('');
 $('myphotos').querySelectorAll('[data-delete]').forEach(b=>b.onclick=()=>run(async()=>{if(!confirm('Delete this household photo?'))return;checked(await db.storage.from('household-photos').remove([`${id}/${b.dataset.delete}`]));await loadMyPhotos();notice('Photo deleted.');}));
}
async function compress(file){if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw new Error('Choose a JPEG, PNG, or WebP image.');if(file.size>15*1024*1024)throw new Error('Choose an image smaller than 15 MB.');const bitmap=await createImageBitmap(file);const scale=Math.min(1,1200/Math.max(bitmap.width,bitmap.height));const canvas=document.createElement('canvas');canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale);canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.8));if(!blob||blob.size>2*1024*1024)throw new Error('This photo is too large after resizing. Try a smaller photo.');return blob;}
async function loadRequests(){const rows=checked(await db.from('access_requests').select('*').eq('neighborhood_id',neighborhood.id).eq('status','pending').order('created_at'));
 $('requests').innerHTML=rows.length?rows.map(r=>`<form class="request" data-request="${r.id}"><h3>${esc(r.name)}</h3><p>${esc(r.address)}</p><label>Existing household<select name="household"><option value="">Create a new household</option>${households.map(h=>`<option value="${h.id}">${esc(h.display_name)} — ${esc(h.address)}</option>`).join('')}</select></label><div class="coordinates"><label>Latitude<input name="lat" type="number" step="any" min="-90" max="90"></label><label>Longitude<input name="lng" type="number" step="any" min="-180" max="180"></label></div><div class="actions"><button class="primary">Approve resident</button><button type="button" data-reject>Reject request</button></div></form>`).join(''):'<p>No pending requests. You’re all caught up.</p>';
 $('requests').querySelectorAll('form').forEach(f=>{f.onsubmit=e=>{e.preventDefault();run(async()=>{const data=new FormData(f);const existing=data.get('household');if(!existing&&(!data.get('lat')||!data.get('lng')))throw new Error('Enter verified coordinates for the new household.');checked(await db.rpc('review_request',{request_id:f.dataset.request,approve:true,lat:existing?null:Number(data.get('lat')),lng:existing?null:Number(data.get('lng')),existing_household:existing||null}));await load();view('admin');notice('Resident approved.');});};f.querySelector('[data-reject]').onclick=()=>run(async()=>{if(!confirm('Reject this access request?'))return;checked(await db.rpc('review_request',{request_id:f.dataset.request,approve:false}));await loadRequests();notice('Request rejected.');});});
}
$('authform').onsubmit=e=>{e.preventDefault();run(async()=>{const f=new FormData(e.target);checked(await db.auth.signInWithPassword({email:f.get('email'),password:f.get('password')}));notice('Signed in.');await load();});};
$('signup').onclick=()=>run(async()=>{const form=$('authform');if(!form.reportValidity())return;const f=new FormData(form);const data=checked(await db.auth.signUp({email:f.get('email'),password:f.get('password'),options:{emailRedirectTo:location.origin+location.pathname}}));if(data.session){await load();notice('Account created. Request resident access below.');}else notice('Check your email to confirm your account, then sign in.');});
$('reset').onclick=()=>run(async()=>{const email=$('authform').elements.email;if(!email.value||!email.checkValidity())throw new Error('Enter your email address first.');checked(await db.auth.resetPasswordForEmail(email.value,{redirectTo:location.origin+location.pathname}));notice('If an account exists, a password reset email will be sent.');});
$('passwordform').onsubmit=e=>{e.preventDefault();run(async()=>{checked(await db.auth.updateUser({password:new FormData(e.target).get('password')}));show('recovery',false);notice('Password updated.');await load();});};
$('signout').onclick=()=>run(async()=>{checked(await db.auth.signOut());show('recovery',false);notice('Signed out.');await load();});
$('joinform').onsubmit=e=>{e.preventDefault();run(async()=>{const f=new FormData(e.target);checked(await db.rpc('request_access',{neighborhood_slug:cfg.neighborhoodSlug,resident_name:f.get('name'),household_address:f.get('address')}));notice('Request submitted.');await load();});};
$('refresh').onclick=()=>run(load);
$('search').oninput=render;
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>view(b.dataset.view));
$('profileform').onsubmit=e=>{e.preventDefault();run(async()=>{const patch=Object.fromEntries(new FormData(e.target));const updated=checked(await db.from('households').update(patch).eq('id',membership.household_id).select().single());households=households.map(h=>h.id===updated.id?updated:h);render();notice('Household profile saved.');});};
$('upload').onchange=()=>run(async()=>{const input=$('upload');const file=input.files[0];if(!file)return;input.disabled=true;try{const id=membership.household_id;if((await photoList(id)).length>=5)throw new Error('Your gallery has five photos. Delete one before adding another.');const blob=await compress(file);checked(await db.storage.from('household-photos').upload(`${id}/${Date.now()}-${crypto.randomUUID()}.jpg`,blob,{contentType:'image/jpeg',upsert:false}));await loadMyPhotos();notice('Photo uploaded privately.');}finally{input.disabled=false;input.value='';}});
db.auth.onAuthStateChange((event)=>{if(event==='PASSWORD_RECOVERY'){show('recovery',true);show('auth',false);}if(event==='SIGNED_OUT')setTimeout(()=>run(load),0);});
run(load);
