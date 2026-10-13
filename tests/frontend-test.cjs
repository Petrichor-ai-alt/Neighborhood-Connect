const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');const {parseHTML}=require('linkedom');
const root=require('node:path').resolve(__dirname,'..')+'/';
async function setup({account='manager',migrated=true,signed=true}={}){
const {window,document}=parseHTML(fs.readFileSync(root+'index.html','utf8'));
Object.defineProperty(window.HTMLElement.prototype,'elements',{configurable:true,get(){const els=[...this.querySelectorAll('input,textarea,select,button')];els.forEach(el=>{if(el.name)els[el.name]=el});return els}});
for(const el of document.querySelectorAll('*')){el.scrollIntoView=()=>{};el.focus=()=>{};el.reportValidity=()=>true;}
const people=[{id:'person1',household_id:'home1',user_id:'manager',display_name:'Sam Manager',bio:'',interests:'Trees',email:'',phone:'',photo_path:''},{id:'person2',household_id:'home1',user_id:null,display_name:'Alex <Unlinked>',bio:'',interests:'Books',email:'',phone:'',photo_path:''},{id:'person3',household_id:'home1',user_id:'member',display_name:'Pat Adult',bio:'',interests:'Running',email:'',phone:'',photo_path:''}];
const homes=[{id:'home1',neighborhood_id:'n1',display_name:'Test home',address:'1 Test Lane',residents:'Legacy summary',bio:'',interests:'',email:'',phone:'',latitude:41,longitude:-88}];let schemaCalls=0;
function from(table){const filters=[];let updates;const q={select(){return this},eq(k,v){filters.push([k,v]);return this},in(k,v){filters.push([k,v]);return this},order(){return this},update(p){updates=p;return this},single(){this.one=true;return this},maybeSingle(){this.one=true;return this},then(resolve){
let rows=table==='neighborhoods'?[{id:'n1',slug:'burr-oaks',name:'Burr Oaks'}]:table==='memberships'?[{user_id:account,neighborhood_id:'n1',household_id:'home1',role:account==='manager'?'admin':'resident',household_role:account==='manager'?'manager':'member'}]:table==='households'?homes:table==='household_members'?people:[];
if(table==='household_members'){schemaCalls++;if(!migrated)return Promise.resolve({data:null,error:{code:'PGRST205'}}).then(resolve)}
rows=rows.filter(r=>filters.every(([k,v])=>Array.isArray(v)?v.includes(r[k]):r[k]===v));return Promise.resolve({data:this.one?(rows[0]||null):rows,error:null}).then(resolve)}};return q;}
const db={from,auth:{getSession:async()=>({data:{session:signed?{user:{id:account,email:'example@test.invalid',user_metadata:{}}}:null}}),onAuthStateChange(){}},storage:{from(){return {list:async()=>({data:[]}),createSignedUrl:async()=>({data:{signedUrl:'https://test.invalid/photo'}})}}},rpc:async(name,args)=>{
if(name==='household_login_roles')return {data:[{member_id:'person1',household_role:'manager'},{member_id:'person3',household_role:'member'}]};
if(name==='save_household_member'){const id=args.person||'person4';const p={id,household_id:args.household,user_id:null,display_name:args.person_name,bio:args.person_bio,interests:args.person_interests,email:args.contact_email,phone:args.contact_phone,photo_path:args.photo};const i=people.findIndex(p=>p.id===id);if(i>=0)people[i]=p;else people.push(p);return {data:id};}return {data:null};}};
window.NC_CONFIG={supabaseUrl:'test',supabaseKey:'test',neighborhoodSlug:'burr-oaks',branding:{name:'Burr Oaks'},center:{lat:41,lng:-88}};window.supabase={createClient:()=>db};window.matchMedia=()=>({matches:false,addEventListener(){}});
class FormDataFake{constructor(form){this.entries=[...form.querySelectorAll('input,textarea,select')].filter(x=>x.name&&!x.disabled).map(x=>[x.name,x.value||''])}get(k){return this.entries.find(([x])=>x===k)?.[1]}[Symbol.iterator](){return this.entries[Symbol.iterator]()}}
const ctx=vm.createContext({window,document,location:{href:'https://example.test/',hash:'',pathname:'/',search:''},URL,URLSearchParams,sessionStorage:{getItem(){return null},setItem(){},removeItem(){}},history:{replaceState(){}},FormData:FormDataFake,console,confirm:()=>true,setTimeout,crypto:require('crypto').webcrypto,navigator:{clipboard:{writeText:async()=>{}}}});
vm.runInContext(fs.readFileSync(root+'members.js','utf8'),ctx);vm.runInContext(fs.readFileSync(root+'app.js','utf8').replace('initMembersUI();\nrun(load);','initMembersUI();'),ctx);vm.runInContext('loadMap=async()=>{}',ctx);
await vm.runInContext('load()',ctx);return {ctx,document,people,getSchemaCalls:()=>schemaCalls};}
(async()=>{
let t=await setup({signed:false});assert.equal(t.document.getElementById('auth').hidden,false);assert.equal(t.document.getElementById('directory').hidden,true);
t=await setup({migrated:false});assert.equal(t.document.getElementById('directory').hidden,false);assert.equal(t.document.getElementById('persontab').hidden,true);assert.equal(t.document.getElementById('upload').disabled,false);
t=await setup();const {ctx,document}=t;
vm.runInContext("view('profile')",ctx);assert.equal(document.getElementById('household-members').hidden,false);assert.equal(document.getElementById('add-member').hidden,false);
assert.equal(document.querySelectorAll('[data-edit-person]').length,2);assert.equal(document.querySelectorAll('[data-invite-person]').length,1);
assert.equal(document.getElementById('my-members').innerHTML.includes('Alex &lt;Unlinked&gt;'),true);
vm.runInContext("$('search').value='Running';render()",ctx);assert.equal(document.querySelectorAll('#households [data-household]').length,1);
await vm.runInContext("detail('home1')",ctx);assert.equal(document.querySelectorAll('#detail [data-person]').length,3);
vm.runInContext("showMemberDetail('person2')",ctx);assert.equal(document.getElementById('detail').textContent.includes('Alex <Unlinked>'),true);
vm.runInContext("view('person');openMemberEditor(null)",ctx);document.querySelector('#memberform input[name=display_name]').value='New person';document.getElementById('memberform').onsubmit({preventDefault(){},target:document.getElementById('memberform')});await new Promise(r=>setTimeout(r,30));assert.equal(t.people.length,4);assert.equal(document.querySelector('#memberform input[name=display_name]').value,'New person');
t=await setup({account:'member'});vm.runInContext("view('profile')",t.ctx);assert.equal(t.document.getElementById('upload').disabled,true);assert.equal(t.document.getElementById('add-member').hidden,true);assert.equal(t.document.querySelectorAll('[data-edit-person]').length,1);assert.equal(t.document.querySelectorAll('[data-member-action]').length,0);
vm.runInContext("view('person')",t.ctx);assert.equal(t.document.querySelector('#memberform input[name=display_name]').value,'Pat Adult');vm.runInContext("openMemberEditor('person1')",t.ctx);assert.equal(t.document.getElementById('memberform'),null);
console.log('PASS: signed-out privacy, pre-migration fallback, manager/member controls, household/member details, escaped names, member search, member creation, personal-profile navigation.');
})().catch(e=>{console.error(e);process.exit(1)});
