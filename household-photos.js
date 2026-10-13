'use strict';
const householdPhotosReady=new Set(),failedStreetViews=new Set(),failedUploadedPhotos=new Set();
function householdPhoto(h){
 if(!membership||h.photo_preference==='none')return null;
 const uploaded=directoryPhotos.get(h.id);
 if(h.photo_preference!=='streetview'&&uploaded&&!failedUploadedPhotos.has(uploaded.url))return {...uploaded,source:'uploaded'};
 if(!cfg.googleMapsKey||!Object.hasOwn(h,'photo_preference')||failedStreetViews.has(h.id))return null;
 if(h.photo_preference!=='streetview'&&!householdPhotosReady.has(h.id))return null;
 const params=new URLSearchParams({size:'600x400',location:h.address,source:'outdoor',return_error_code:'true',key:cfg.googleMapsKey});
 return {url:`https://maps.googleapis.com/maps/api/streetview?${params}`,source:'streetview'};
}
function householdImage(h,kind='directory'){
 const photo=householdPhoto(h),fallback=`<span class="house-photo-fallback house-photo-${kind}" ${photo?'hidden':''} aria-hidden="true">${esc(initials(h))}</span>`;
 if(!photo)return fallback;
 return `<span class="house-photo house-photo-${kind} ${photo.source==='streetview'?'google-house-photo':''}"><img src="${esc(photo.url)}" alt="${esc(h.display_name)} ${photo.source==='streetview'?'Google Street View':'household'} photo" loading="lazy" data-photo-household="${h.id}" data-photo-source="${photo.source}" onerror="window.ncHousePhotoError(this)">${photo.source==='streetview'?'<span class="google-photo-attribution">Google Maps · Street View</span>':''}</span>${fallback}`;
}
window.ncHousePhotoError=img=>{
 const id=img.dataset.photoHousehold;if(img.dataset.photoSource==='streetview')failedStreetViews.add(id);else failedUploadedPhotos.add(img.getAttribute('src'));
 const host=img.closest('.house-photo');if(!host)return;host.hidden=true;if(host.nextElementSibling)host.nextElementSibling.hidden=false;
 // Do not repeatedly retry unavailable Google imagery on each search/render.
 const h=households.find(h=>h.id===id),next=h&&householdPhoto(h);
 if(next&&next.source==='streetview'&&img.dataset.photoSource!=='streetview'){
  const holder=document.createElement('span');holder.innerHTML=householdImage(h,[...host.classList].find(c=>/^house-photo-(directory|overview|neighbor|detail|preview)$/.test(c))?.slice(12)||'directory');
  const fallback=host.nextElementSibling;host.replaceWith(...holder.childNodes);fallback?.remove();
 }
};
function fillHouseholdPhotoControls(){
 const h=households.find(h=>h.id===membership?.household_id);if(!h)return;
 const ready=Object.hasOwn(h,'photo_preference');show('house-photo-settings',ready);if(!ready)return;
 $('photo-preference').value=h.photo_preference;$('photo-preference').disabled=!canManageHousehold();$('save-photo-preference').disabled=!canManageHousehold();
 $('house-photo-preview').innerHTML=householdImage(h,'preview');
 $('house-photo-status').textContent=h.photo_preference==='none'?'House images are hidden on your household page and cards.':householdPhoto(h)?.source==='uploaded'?'Your uploaded photo is displayed.':'Street View appears when Google has an image. It may show an older view or a neighboring property.';
}
function initHouseholdPhotos(){
 $('photo-preference-form').onsubmit=e=>{e.preventDefault();run(async()=>{
  if(!canManageHousehold())throw new Error('A household manager can change this setting.');
  const button=$('save-photo-preference');button.disabled=true;
  try{const updated=checked(await db.from('households').update({photo_preference:$('photo-preference').value}).eq('id',membership.household_id).select().single());households=households.map(h=>h.id===updated.id?updated:h);failedStreetViews.delete(updated.id);render();fillHouseholdPhotoControls();notice('Household photo preference saved.');}
  finally{button.disabled=!canManageHousehold();}
 });};
}
