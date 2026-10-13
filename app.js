'use strict';
const cfg={...window.NC_CONFIG,authRedirectUrl:new URL('./',location.href).href};
const db=window.supabase.createClient(cfg.supabaseUrl,cfg.supabaseKey);
const $=id=>document.getElementById(id);
const branding=cfg.branding||{};
let neighborhoodName=branding.name||'Your neighborhood';
$('brand-neighborhood').textContent=neighborhoodName;$('mobile-neighborhood').textContent=neighborhoodName;
$('brand-location').textContent=branding.location||'';
$('footer-neighborhood').textContent=` / ${neighborhoodName}`;
$('join-heading').textContent=`Join ${neighborhoodName}`;
$('page-eyebrow').textContent=`${neighborhoodName} · Your neighborhood community`;
$('profile-audience').textContent=`Share what you’re comfortable sharing. Approved ${neighborhoodName} residents can see this profile.`;
$('map').setAttribute('aria-label',`${neighborhoodName} household map`);
if(branding.areaDescription)$('join').querySelector('p').textContent=branding.areaDescription;
if(branding.signImage)document.querySelectorAll('[data-neighborhood-sign]').forEach(img=>{img.src=new URL(branding.signImage,cfg.authRedirectUrl).href;img.alt=`${neighborhoodName} neighborhood sign`;});
if(branding.favicon)document.querySelector('link[rel="icon"]').href=new URL(branding.favicon,cfg.authRedirectUrl).href;
document.title=`Neighborhood Connect · ${neighborhoodName}`;
let user,neighborhood,membership,households=[],map,markers=[],generation=0;
let selectedFilter='all',greetingName='';
const directoryPhotos=new Map();
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function notice(message,error=false){$('notice').textContent=message;$('notice').classList.toggle('error',error);}
function checked(result){if(result.error)throw result.error;return result.data;}
async function run(fn){try{await fn();}catch(e){notice(e.message||'Something went wrong. Please try again.',true);}}
function show(id,visible){$(id).hidden=!visible;}
function view(id){
 if(id==='person'&&!membersEnabled)return;
 if(!membership||(id==='admin'&&membership.role!=='admin'))return;
 ['overview','browse','mapview','profile','person','admin'].forEach(x=>show(x,x===id));
 document.querySelectorAll('[data-view]').forEach(b=>{const active=b.dataset.view===id;b.classList.toggle('active',active);if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
 const pages={overview:[greetingName?`Welcome back, ${greetingName}`:'Welcome back',neighborhoodName],browse:['Meet your neighbors',`A private directory of ${neighborhoodName} households.`],mapview:[`Explore ${neighborhoodName}`,'Find the households around you. Select a pin to open a profile.'],profile:['Your household','A little introduction goes a long way. Share what makes your household yours.'],person:['Your personal profile','Help your neighbors get to know you.'],admin:['Your neighborhood dashboard','Review resident requests and help your community find its way in.']};
 $('page-eyebrow').textContent=`${neighborhoodName} · ${id==='admin'?'Administration':'Resident community'}`;
 $('page-title').textContent=pages[id][0];$('page-description').textContent=pages[id][1];
 $('main-content').dataset.view=id;show('page-eyebrow',id!=='overview');const browsing=id==='browse'||id==='mapview';show('directory-search',browsing||id==='overview');show('directory-controls',browsing);show('detail',false);
 if(id==='overview'||id==='mapview')run(async()=>{const host=id==='overview'?$('overview-map'):$('mapview').querySelector('.map-shell');host.prepend($('map'));await loadMap();if(map&&membership){const preview=!$('overview').hidden;map.setOptions({disableDefaultUI:preview,gestureHandling:preview?'none':'cooperative',clickableIcons:!preview});google.maps.event.trigger(map,'resize');drawMarkers(preview?households:visibleHouseholds());}});
 if(id==='person')openMemberEditor(members.find(p=>p.user_id===user.id&&p.household_id===membership.household_id)?.id);
 const menuWasOpen=document.body.classList.contains('sidebar-open');closeSidebar(false);if(menuWasOpen){$('page-title').setAttribute('tabindex','-1');$('page-title').focus();}
}
async function load(){
 const version=++generation;
 const session=checked(await db.auth.getSession());user=session.session?.user;
 ['auth','join','pending','directory','topnav','admintab','account-role','account-avatar','directory-search','directory-controls','persontab'].forEach(x=>show(x,false));show('signout',!!user);syncInvitePanel();
 $('page-eyebrow').textContent=`${neighborhoodName} · Your neighborhood community`;
 $('page-title').textContent='Welcome to your neighborhood';
 $('page-description').textContent='Your private community, in one place.';show('page-eyebrow',true);
 if(!user){households=[];membership=null;members=[];memberPhotoUrls.clear();membersEnabled=false;greetingName='';closeSidebar(false);directoryPhotos.clear();householdPhotosReady.clear();failedStreetViews.clear();failedUploadedPhotos.clear();selectedFilter='all';markers.forEach(m=>m.map=null);markers=[];$('households').replaceChildren();$('detail').replaceChildren();$('myphotos').replaceChildren();$('house-photo-preview').replaceChildren();$('requests').replaceChildren();$('my-members').replaceChildren();$('person-editor').replaceChildren();$('member-invite-output').replaceChildren();householdLoginRoles.clear();[...$('profileform').elements].forEach(el=>{if(el.name)el.value='';});show('detail',false);if(!$('recovery').hidden)return;show('auth',true);return;}
 neighborhood=checked(await db.from('neighborhoods').select('*').eq('slug',cfg.neighborhoodSlug).single());
 neighborhoodName=neighborhood.name;$('brand-neighborhood').textContent=neighborhoodName;$('join-heading').textContent=`Join ${neighborhoodName}`;$('footer-neighborhood').textContent=` / ${neighborhoodName}`;document.title=`Neighborhood Connect · ${neighborhoodName}`;
 membership=checked(await db.from('memberships').select('*').eq('user_id',user.id).eq('neighborhood_id',neighborhood.id).maybeSingle());
 if(version!==generation)return;
 if(!membership){
  show('invite-panel',true);
  const request=checked(await db.from('access_requests').select('status').eq('user_id',user.id).eq('neighborhood_id',neighborhood.id).maybeSingle());
  show(request?'pending':'join',true);
  $('pending-title').textContent=request?.status==='rejected'?'Request reviewed':request?.status==='approved'?'Your household access is no longer active':"You're on the list";
  $('pending-description').textContent=request?.status==='rejected'?'Your request was not approved. Contact the neighborhood administrator to correct or discuss your address.':request?.status==='approved'?'Ask your household manager or neighborhood administrator about restoring access. If you have a new invitation, accept it below.':'Your request is awaiting administrator review. Household profiles and photos remain private until you’re approved.';
  return;
 }
 syncInvitePanel();
 households=checked(await db.from('households').select('*').eq('neighborhood_id',neighborhood.id).order('display_name'));
 if(version!==generation)return;
 await loadHouseholdMembers(version);if(version!==generation)return;
 const ownRequest=checked(await db.from('access_requests').select('name').eq('user_id',user.id).eq('neighborhood_id',neighborhood.id).maybeSingle());
 if(version!==generation)return;
 greetingName=(members.find(p=>p.user_id===user.id&&p.household_id===membership.household_id)?.display_name||user.user_metadata?.full_name||ownRequest?.name||'').trim().split(/\s+/)[0];
 show('persontab',membersEnabled);show('directory',true);show('topnav',true);show('admintab',membership.role==='admin');show('account-role',true);show('account-avatar',true);$('account-avatar').textContent=(user.email?.split('@')[0].replace(/[^a-z]/gi,'').slice(0,2)||'NC').toUpperCase();$('account-role').textContent=membership.role==='admin'?'Neighborhood admin':'Resident';$('map-caption-label').textContent=neighborhoodName;view('overview');render();fillProfile();renderMemberManagement();renderOverview();
 await Promise.all([loadMyPhotos(),loadDirectoryPhotos(version),membership.role==='admin'?loadRequests():Promise.resolve()]);
}
function tags(h){return (h.interests||'').split(',').map(t=>t.trim()).filter(Boolean);}
function initials(h){return h.display_name.replace(/^the\s+/i,'').split(/\s+/).slice(0,2).map(s=>s[0]||'').join('').toUpperCase();}
function visibleHouseholds(){
 const q=$('search').value.trim().toLowerCase();
 const rows=households.filter(h=>{
  const match=[h.display_name,h.residents,h.address,h.interests,...members.filter(p=>p.household_id===h.id).flatMap(p=>[p.display_name,p.interests])].join(' ').toLowerCase().includes(q);
  return match&&(selectedFilter==='all'||(selectedFilter==='photos'?!!householdPhoto(h):tags(h).some(t=>t.toLowerCase()===selectedFilter)));
 });
 const sort=$('sort').value==='address'?'address':'display_name';
 return rows.sort((a,b)=>a[sort].localeCompare(b[sort],undefined,{numeric:true,sensitivity:'base'}));
}
function renderFilters(){
 const popular=new Map();households.forEach(h=>tags(h).forEach(t=>{const key=t.toLowerCase();const v=popular.get(key)||{name:t,count:0};v.count++;popular.set(key,v);}));
 const options=[['all','All households'],['photos','With photos'],...[...popular].sort((a,b)=>b[1].count-a[1].count).slice(0,4).map(([k,v])=>[k,v.name])];
 $('filters').innerHTML=options.map(([key,label])=>`<button data-filter="${esc(key)}" class="filter-chip ${selectedFilter===key?'active':''}" aria-pressed="${selectedFilter===key}">${esc(label)}</button>`).join('');
 $('filters').querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{selectedFilter=b.dataset.filter;render();});
}
function render(){
 const visible=visibleHouseholds();renderFilters();
  $('count').textContent=visible.length===households.length?`${households.length} household${households.length===1?'':'s'}`:`${visible.length} of ${households.length} households`;
 $('households').innerHTML=visible.length?visible.map(h=>{
  const interests=tags(h).slice(0,2);
  return `<button class="card" data-household="${h.id}">${householdImage(h,'directory')}<span class="card-body"><span class="card-name">${esc(h.display_name)}</span><span class="card-address">${esc(h.address)}</span>${h.residents?`<span class="card-residents">${esc(h.residents)}</span>`:''}<span class="card-bottom"><span class="card-tags">${interests.map(t=>`<span class="badge">${esc(t)}</span>`).join('')}</span><span class="card-action">View household <span aria-hidden="true">→</span></span></span></span></button>`;
 }).join(''):'<div class="empty-state"><div class="empty-icon" aria-hidden="true">⌂</div><h3>No households found</h3><p>Try another search or filter.</p><button id="clear-filters">Clear search and filters</button></div>';
 $('households').querySelectorAll('[data-household]').forEach(b=>b.onclick=()=>run(()=>detail(b.dataset.household)));
 if($('clear-filters'))$('clear-filters').onclick=()=>{$('search').value='';selectedFilter='all';render();};
 renderOverview();if(map&&(!$('mapview').hidden||!$('overview').hidden))drawMarkers(!$('overview').hidden?households:visible);
}
function renderOverview(){
 if(!membership)return;
 $('overview-count').textContent=`${households.length} household${households.length===1?'':'s'}`;
 $('overview-privacy-title').textContent=`${neighborhoodName} residents only`;
 $('overview-map-title').textContent=`Explore ${neighborhoodName}`;
 $('overview-neighbor-description').textContent=`A few familiar faces in ${neighborhoodName}.`;
 const h=households.find(h=>h.id===membership.household_id);if(!h)return;
 const chosenPhoto=householdPhoto(h);const photo=chosenPhoto?.source==='uploaded'?chosenPhoto.url:null;
 const houseIcon='<svg aria-hidden="true" viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1"><path d="m3 10 9-7 9 7v11H3zM9 21v-7h6v7"/></svg>';
 const gap=!h.interests?['Complete your profile','Add your interests to help neighbors get to know you.','Add your interests','interests']:!h.bio?['Introduce your household','Share a little about yourselves with your community.','Add an introduction','bio']:!photo?['Put a face to your household','Add a photo to make your profile feel more like home.','Add a photo','upload']:['Your household is ready','Keep your details up to date as things change.','Update profile','display_name'];
 $('overview-household').innerHTML=`<div class="household-cover">${householdImage(h,'overview')}</div><div class="household-identity">${photo?`<img class="overview-avatar" src="${esc(photo)}" alt="">`:`<span class="overview-avatar overview-initials" aria-hidden="true">${esc(initials(h))}</span>`}<div><h3>${esc(h.display_name)}</h3><p>${esc(h.address)}</p><small>${membersEnabled?`${members.filter(p=>p.household_id===h.id).length} household members`:(h.residents?'Residents listed on your profile':'Your home in '+esc(neighborhoodName))}</small></div></div><div class="profile-prompt"><span class="prompt-icon" aria-hidden="true">✎</span><div><strong>${gap[0]}</strong><p>${gap[1]}</p></div><button id="overview-complete">${gap[2]}</button></div>`;
 $('overview-complete').onclick=()=>{view('profile');const target=gap[3]==='upload'?$('upload'):$('profileform').elements[gap[3]];target?.focus();};
 const neighbors=households.filter(n=>n.id!==h.id).slice(0,3);
 $('overview-neighbors').innerHTML=neighbors.length?neighbors.map(n=>{const interest=tags(n)[0];return `<button class="neighbor-card" data-neighbor="${n.id}">${householdImage(n,'neighbor')}<span><strong>${esc(n.display_name)}</strong><small>${esc(n.address)}</small>${interest?`<span class="neighbor-tag">${esc(interest)}</span>`:''}</span></button>`;}).join(''):'<p class="neighbors-empty">Additional approved households will appear here as your directory grows.</p>';
 $('overview-neighbors').querySelectorAll('[data-neighbor]').forEach(b=>b.onclick=()=>run(()=>detail(b.dataset.neighbor)));
}
async function refreshHouseholdPhoto(id,version=generation){
 try{const files=await photoList(id);const url=files.length?await photoUrl(`${id}/${files[0].name}`):null;if(version!==generation||!membership)return;if(url)directoryPhotos.set(id,{url});else directoryPhotos.delete(id);}
 catch(e){if(version===generation)directoryPhotos.delete(id);}
 finally{if(version===generation&&membership)householdPhotosReady.add(id);}
}
async function loadDirectoryPhotos(version){
 const queue=households.map(h=>h.id);
 await Promise.all(Array.from({length:Math.min(4,queue.length)},async()=>{while(queue.length&&version===generation){await refreshHouseholdPhoto(queue.shift(),version);}}));
 if(version===generation&&membership){render();fillHouseholdPhotoControls();}
}
let mapsPromise;
async function loadMap(){
 if(!mapsPromise)mapsPromise=new Promise((resolve,reject)=>{window.ncMapsReady=resolve;window.gm_authFailure=()=>{notice('Google Maps could not authorize this website. Check billing, API enablement, and website restrictions.',true);};const s=document.createElement('script');s.src=`https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(cfg.googleMapsKey)}&libraries=marker&loading=async&callback=ncMapsReady`;s.onerror=()=>{mapsPromise=null;reject(new Error('Map could not load. Directory cards still work.'));};document.head.append(s);});
 try{await mapsPromise;if(!map)map=new google.maps.Map($('map'),{center:cfg.center,zoom:15,mapId:cfg.mapId,mapTypeControl:true,streetViewControl:false});render();}catch(e){notice(e.message,true);}
}
function drawMarkers(rows){markers.forEach(m=>m.map=null);markers=rows.map(h=>{const pin=document.createElement('div');pin.className='household-pin';pin.innerHTML='<svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor" aria-hidden="true"><path d="M3 11 12 3l9 8h-3v10h-5v-6h-2v6H6V11z"/></svg>';const m=new google.maps.marker.AdvancedMarkerElement({map,content:pin,position:{lat:h.latitude,lng:h.longitude},title:h.display_name});m.addListener('click',()=>run(()=>detail(h.id)));return m;});if(rows.length){const bounds=new google.maps.LatLngBounds();rows.forEach(h=>bounds.extend({lat:h.latitude,lng:h.longitude}));map.fitBounds(bounds);google.maps.event.addListenerOnce(map,'idle',()=>{const maxZoom=!$('overview').hidden?15:17;if(map.getZoom()>maxZoom)map.setZoom(maxZoom);});}}
async function photoList(id){return checked(await db.storage.from('household-photos').list(id,{limit:100,sortBy:{column:'name',order:'asc'}})).filter(f=>f.id);}
async function photoUrl(path){return checked(await db.storage.from('household-photos').createSignedUrl(path,300)).signedUrl;}
async function detail(id){
 const version=generation;const h=households.find(x=>x.id===id);if(!h)return;if(!$('overview').hidden)view('browse');
 const files=h.photo_preference==='none'?[]:await photoList(id);const urls=await Promise.all(files.map(f=>photoUrl(`${id}/${f.name}`)));
 if(version!==generation||!user)return;
 await refreshHouseholdPhoto(id,version);if(version!==generation||!user)return;
 $('detail').innerHTML=`<h2>${esc(h.display_name)}</h2>${householdImage(h,'detail')}<p>${esc(h.address)}</p><p>${esc(h.residents)}</p><p>${esc(h.bio)}</p>${h.interests?`<p><strong>Interests:</strong> ${esc(h.interests)}</p>`:''}${h.email?`<p><strong>Email:</strong> ${esc(h.email)}</p>`:''}${h.phone?`<p><strong>Phone:</strong> ${esc(h.phone)}</p>`:''}<div class="photos">${urls.map(url=>`<figure><img src="${esc(url)}" alt="Household photo" loading="lazy"></figure>`).join('')}</div>${membersEnabled?`<h3>Household members</h3><div class="member-grid">${memberCards(h.id)}</div>`:''}<p><a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(h.latitude+','+h.longitude)}">Open in Google Maps</a></p><button id="closedetail">Close profile</button>`;
 wireMemberCards($('detail'));show('detail',true);$('closedetail').onclick=()=>show('detail',false);$('detail').scrollIntoView({behavior:'smooth',block:'start'});
}
function fillProfile(){const h=households.find(h=>h.id===membership.household_id);if(!h)return;$('myaddress').textContent=h.address;['display_name','residents','email','phone','interests','bio'].forEach(k=>$('profileform').elements[k].value=h[k]||'');const editable=canManageHousehold();[...$('profileform').elements].forEach(el=>el.disabled=!editable);$('upload').disabled=!editable;show('household-permission',!editable);fillHouseholdPhotoControls();$('household-permission').textContent='A household manager maintains this shared profile and its photos. You can edit your personal profile in My profile.';}
async function loadMyPhotos(){const id=membership.household_id;const version=generation;const files=await photoList(id);const urls=await Promise.all(files.map(f=>photoUrl(`${id}/${f.name}`)));if(version!==generation)return;
 $('myphotos').innerHTML=files.map((f,i)=>`<figure><img src="${esc(urls[i])}" alt="Your household photo ${i+1}">${canManageHousehold()?`<button data-delete="${esc(f.name)}">Delete photo</button>`:''}</figure>`).join('');
 $('myphotos').querySelectorAll('[data-delete]').forEach(b=>b.onclick=()=>run(async()=>{if(!confirm('Delete this household photo?'))return;checked(await db.storage.from('household-photos').remove([`${id}/${b.dataset.delete}`]));await loadMyPhotos();await refreshHouseholdPhoto(id);render();fillHouseholdPhotoControls();notice('Photo deleted.');}));
}
async function compress(file){if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw new Error('Choose a JPEG, PNG, or WebP image.');if(file.size>15*1024*1024)throw new Error('Choose an image smaller than 15 MB.');const bitmap=await createImageBitmap(file);const scale=Math.min(1,1200/Math.max(bitmap.width,bitmap.height));const canvas=document.createElement('canvas');canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale);canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.8));if(!blob||blob.size>2*1024*1024)throw new Error('This photo is too large after resizing. Try a smaller photo.');return blob;}
async function loadRequests(){const rows=checked(await db.from('access_requests').select('*').eq('neighborhood_id',neighborhood.id).eq('status','pending').order('created_at'));
 $('requests').innerHTML=rows.length?rows.map(r=>`<form class="request" data-request="${r.id}"><h3>${esc(r.name)}</h3><p>${esc(r.address)}</p><label>Existing household<select name="household"><option value="">Create a new household</option>${households.map(h=>`<option value="${h.id}">${esc(h.display_name)} — ${esc(h.address)}</option>`).join('')}</select></label><div class="coordinates"><label>Latitude<input name="lat" type="number" step="any" min="-90" max="90"></label><label>Longitude<input name="lng" type="number" step="any" min="-180" max="180"></label></div><div class="actions"><button class="primary">Approve resident</button><button type="button" data-reject>Reject request</button></div></form>`).join(''):'<p>No pending requests. You’re all caught up.</p>';
 $('requests').querySelectorAll('form').forEach(f=>{f.onsubmit=e=>{e.preventDefault();run(async()=>{const data=new FormData(f);const existing=data.get('household');if(!existing&&(!data.get('lat')||!data.get('lng')))throw new Error('Enter verified coordinates for the new household.');checked(await db.rpc('review_request',{request_id:f.dataset.request,approve:true,lat:existing?null:Number(data.get('lat')),lng:existing?null:Number(data.get('lng')),existing_household:existing||null}));await load();view('admin');notice('Resident approved.');});};f.querySelector('[data-reject]').onclick=()=>run(async()=>{if(!confirm('Reject this access request?'))return;checked(await db.rpc('review_request',{request_id:f.dataset.request,approve:false}));await loadRequests();notice('Request rejected.');});});
}
$('authform').onsubmit=e=>{e.preventDefault();run(async()=>{const f=new FormData(e.target);checked(await db.auth.signInWithPassword({email:f.get('email'),password:f.get('password')}));notice('Signed in.');await load();});};
$('signup').onclick=()=>run(async()=>{const form=$('authform');if(!form.reportValidity())return;const f=new FormData(form);const data=checked(await db.auth.signUp({email:f.get('email'),password:f.get('password'),options:{emailRedirectTo:cfg.authRedirectUrl}}));if(data.session){await load();notice(invitationCode?'Account created. Accept your household invitation below.':'Account created. Request resident access below.');}else notice('Check your email to confirm your account, then sign in.');});
$('reset').onclick=()=>run(async()=>{const email=$('authform').elements.email;if(!email.value||!email.checkValidity())throw new Error('Enter your email address first.');checked(await db.auth.resetPasswordForEmail(email.value,{redirectTo:cfg.authRedirectUrl}));notice('If an account exists, a password reset email will be sent.');});
$('passwordform').onsubmit=e=>{e.preventDefault();run(async()=>{checked(await db.auth.updateUser({password:new FormData(e.target).get('password')}));show('recovery',false);notice('Password updated.');await load();});};
$('signout').onclick=()=>run(async()=>{checked(await db.auth.signOut());show('recovery',false);notice('Signed out.');await load();});
$('joinform').onsubmit=e=>{e.preventDefault();run(async()=>{const f=new FormData(e.target);checked(await db.rpc('request_access',{neighborhood_slug:cfg.neighborhoodSlug,resident_name:f.get('name'),household_address:f.get('address')}));notice('Request submitted.');await load();});};
$('refresh').onclick=()=>run(load);
$('search').oninput=()=>{if(!$('overview').hidden&&$('search').value.trim())view('browse');render();};
$('sort').onchange=render;
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>view(b.dataset.view));
$('profileform').onsubmit=e=>{e.preventDefault();run(async()=>{const patch=Object.fromEntries(new FormData(e.target));const updated=checked(await db.from('households').update(patch).eq('id',membership.household_id).select().single());households=households.map(h=>h.id===updated.id?updated:h);render();notice('Household profile saved.');});};
$('upload').onchange=()=>run(async()=>{const input=$('upload');const file=input.files[0];if(!file)return;input.disabled=true;try{const id=membership.household_id;if((await photoList(id)).length>=5)throw new Error('Your gallery has five photos. Delete one before adding another.');const blob=await compress(file);checked(await db.storage.from('household-photos').upload(`${id}/${Date.now()}-${crypto.randomUUID()}.jpg`,blob,{contentType:'image/jpeg',upsert:false}));const h=households.find(h=>h.id===id);if(Object.hasOwn(h,'photo_preference')&&h.photo_preference!=='auto'){const updated=checked(await db.from('households').update({photo_preference:'auto'}).eq('id',id).select().single());households=households.map(h=>h.id===id?updated:h);}await loadMyPhotos();await refreshHouseholdPhoto(id);render();fillHouseholdPhotoControls();notice('Photo uploaded privately.');}finally{input.disabled=!canManageHousehold();input.value='';}});
const mobileLayout=window.matchMedia('(max-width: 850px)');
function closeSidebar(restoreFocus=true){
 document.body.classList.remove('sidebar-open');$('menu-toggle').setAttribute('aria-expanded','false');show('sidebar-backdrop',false);
 if(window.matchMedia('(max-width: 850px)').matches)$('site-sidebar').inert=true;
 if(restoreFocus)$('menu-toggle').focus();
}
function openSidebar(){
 $('site-sidebar').inert=false;document.body.classList.add('sidebar-open');$('menu-toggle').setAttribute('aria-expanded','true');show('sidebar-backdrop',true);
 const first=$('topnav').hidden?$('sidebar-close'):$('topnav').querySelector('button:not([hidden])');first?.focus();
}
function syncSidebar(){closeSidebar(false);$('site-sidebar').inert=mobileLayout.matches;}
$('menu-toggle').onclick=openSidebar;$('sidebar-close').onclick=()=>closeSidebar();$('sidebar-backdrop').onclick=()=>closeSidebar();
$('overview-edit').onclick=()=>view('profile');$('overview-open-map').onclick=()=>view('mapview');$('overview-browse').onclick=()=>view('browse');
mobileLayout.addEventListener('change',syncSidebar);syncSidebar();
document.addEventListener('keydown',e=>{if(!document.body.classList.contains('sidebar-open'))return;if(e.key==='Escape')closeSidebar();if(e.key==='Tab'){const focusable=[...$('site-sidebar').querySelectorAll('a[href],button:not([hidden])')].filter(el=>!el.closest('[hidden]'));const first=focusable[0],last=focusable.at(-1);if(!first)return;if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}});
db.auth.onAuthStateChange((event)=>{if(event==='PASSWORD_RECOVERY'){show('recovery',true);show('auth',false);}if(event==='SIGNED_OUT')setTimeout(()=>run(load),0);});
initMembersUI();
initHouseholdPhotos();
run(load);



