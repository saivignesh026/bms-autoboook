const api=globalThis.browser||chrome;
const $=id=>document.getElementById(id);
const fields=['name','theatre','email','phone','discord'];
let config,current,dirty=false;
async function send(m){const r=await api.runtime.sendMessage(m);if(!r?.ok)throw Error(r?.error||'No response.');return r.data;}
function show(message,error=false){$('status').textContent=message;$('status').className=`status sticky-message ${error?'error':'success'}`;}
function read(){for(const field of fields)current[field]=$(field).value.trim();current.ticketCount=Number($('ticketCount').value);Object.assign(current,BMS.validateProfile(current));}
function render(){
  $('profileList').replaceChildren();
  for(const p of config.profiles){const button=document.createElement('button');button.className='profile-item'+(p.id===current.id?' selected':'');const title=document.createElement('strong'),sub=document.createElement('span');title.textContent=p.name;sub.textContent=p.theatre||'Set theatre';button.append(title,sub);button.onclick=()=>perform(async()=>{read();current=p;config.activeProfile=p.id;render();});$('profileList').append(button);}
  $('editorTitle').textContent=current.name;
  for(const field of fields)$(field).value=current[field];$('ticketCount').value=String(current.ticketCount);
  $('copyFrom').replaceChildren();const blank=document.createElement('option');blank.value='';blank.textContent='Choose a profile…';$('copyFrom').append(blank);
  for(const p of config.profiles.filter(p=>p.id!==current.id)){const option=document.createElement('option');option.value=p.id;option.textContent=p.name;$('copyFrom').append(option);}
  $('seats').replaceChildren();for(const z of current.zones){const chip=document.createElement('span');chip.className='seat-chip';chip.textContent=z.name;$('seats').append(chip);}
  $('seatHint').textContent=current.zones.length?`${current.zones.length} seat area(s) saved. Adjust them when you change the show or map position.`:'No seats saved yet. Open the BookMyShow seat map, then click Adjust seats.';
  $('discordStatus').textContent=current.discordTest?current.discordTest.ok?`Last Discord test delivered at ${new Date(current.discordTest.at).toLocaleString()}`:`Last test failed: ${current.discordTest.error}`:'Not tested yet. Use Save & test Discord to confirm delivery.';
}
async function perform(fn){try{await fn();}catch(e){show(e.message,true);}}
async function save(){read();config.activeProfile=current.id;await send({type:'saveConfig',config});dirty=false;show('Profile saved.');}
for(const field of [...fields,'ticketCount'])$(field).addEventListener('input',()=>dirty=true);
$('save').onclick=()=>perform(save);
$('new').onclick=()=>perform(async()=>{read();if(config.profiles.length>=30)throw Error('You can save up to 30 profiles.');current=BMS.validateProfile({id:crypto.randomUUID(),name:`Theatre ${config.profiles.length+1}`});config.profiles.push(current);dirty=true;render();show('Enter this theatre’s details, then Save profile.');});
$('duplicate').onclick=()=>perform(async()=>{read();if(config.profiles.length>=30)throw Error('You can save up to 30 profiles.');current=BMS.copyProfile(current,crypto.randomUUID());config.profiles.push(current);dirty=true;render();show('Copied contact details and webhook. Rename the profile, set the theatre and choose its seats.');});
$('copyFrom').onchange=()=>perform(async()=>{const source=config.profiles.find(p=>p.id===$('copyFrom').value);if(!source)return;read();for(const field of ['email','phone','discord'])current[field]=source[field];delete current.discordTest;dirty=true;render();show(`Copied contact details and webhook from ${source.name}. Save to apply.`);});
$('delete').onclick=()=>perform(async()=>{if(config.profiles.length===1)throw Error('Keep at least one profile.');if(!confirm(`Delete ${current.name}?`))return;config.profiles=config.profiles.filter(p=>p.id!==current.id);current=config.profiles[0];render();await save();});
$('test').onclick=()=>perform(async()=>{
  $('test').disabled=true;
  try{await save();show('Sending test message…');const result=await send({type:'testNotification',profileId:current.id});config=await send({type:'config'});current=config.profiles.find(p=>p.id===current.id);render();show(result);}finally{$('test').disabled=false;}
});
$('choose').onclick=()=>perform(async()=>{
  await save();const tabs=await api.tabs.query({currentWindow:true,url:'https://*.bookmyshow.com/*'});
  const tab=tabs.find(t=>t.active&&t.url.includes('/seat-layout/'))||tabs.find(t=>t.url.includes('/seat-layout/'));
  if(!tab)throw Error('Open the BookMyShow seat-selection screen first.');
  await send({type:'prepareLayout',tabId:tab.id,profileId:current.id});await api.tabs.update(tab.id,{active:true});
  const r=await api.tabs.sendMessage(tab.id,{type:'calibrate'});if(!r?.ok)throw Error(r?.error||'Reload BookMyShow and try again.');
});
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
send({type:'config'}).then(c=>{config=c;current=c.profiles.find(p=>p.id===c.activeProfile)||c.profiles[0];render();}).catch(e=>show(e.message,true));
