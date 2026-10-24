/* Shared deterministic helpers: no DOM or network access. */
(() => {
  const defaults = {
    id: 'default', name: 'My theatre', theatre: '', discord: '', urlMatch: '', zones: [],
    minInterval: 65, maxInterval: 140, maxReloads: 30, ticketCount: 1,
    autoSelect: true, checkout: true, skipFood: true,
    sendScreenshots: true, showZones: true, email: '', phone: '',
    canvasSelector: '', selectedSelector: '',
    green: {rMax: 90, gMin: 130, gMax: 210, bMax: 90}
  };
  function validateProfile(value) {
    const p = {...defaults, ...value, green: {...defaults.green, ...value.green}};
    if (typeof p.id !== 'string' || !p.id || typeof p.name !== 'string' || !p.name.trim()) throw Error('Give the profile a name.');
    for (const key of ['theatre','discord','urlMatch','email','phone','canvasSelector','selectedSelector']) if (typeof p[key] !== 'string') throw Error(`Invalid ${key}.`);
    p.discord=webhook(p.discord);
    if(p.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email))throw Error('Enter a valid email for this profile.');
    if(p.phone&&p.phone.replace(/\D/g,'').length<7)throw Error('Enter a valid mobile number for this profile.');
    for (const key of ['autoSelect','checkout','skipFood','sendScreenshots','showZones']) if (typeof p[key] !== 'boolean') throw Error(`Invalid ${key}.`);
    if (!Number.isFinite(p.minInterval) || !Number.isFinite(p.maxInterval) || p.minInterval < 30 || p.maxInterval < p.minInterval || p.maxInterval > 3600) throw Error('Reload intervals must be 30–3600 seconds; maximum must be at least minimum.');
    if (!Number.isInteger(p.maxReloads) || p.maxReloads < 1 || p.maxReloads > 1000) throw Error('Reload limit must be 1–1000.');
    if (!Number.isInteger(p.ticketCount) || p.ticketCount < 1 || p.ticketCount > 6) throw Error('Ticket count must be 1–6.');
    if (!Array.isArray(p.zones) || p.zones.length > 50) throw Error('Use at most 50 zones.');
    p.zones = p.zones.map(z => {
      if (typeof z.name !== 'string' || !z.name.trim()) throw Error('Every zone needs a name.');
      for (const k of ['top','bottom','left','right']) if (!Number.isFinite(z[k]) || z[k] < 0 || z[k] > 1) throw Error('Zone coordinates must be between 0 and 1.');
      if (z.top >= z.bottom || z.left >= z.right) throw Error('Zone width and height must be positive.');
      return {name:z.name, top:z.top, bottom:z.bottom, left:z.left, right:z.right};
    });
    for (const n of Object.values(p.green)) if (!Number.isInteger(n) || n < 0 || n > 255) throw Error('Color thresholds must be integers from 0 to 255.');
    if (p.green.gMin >= p.green.gMax) throw Error('Green minimum must be below maximum.');
    return p;
  }
  function isGreen(r,g,b, settings = defaults.green) {
    return r < settings.rMax && g > settings.gMin && g < settings.gMax && b < settings.bMax;
  }
  function components(data, width, height, settings = defaults.green) {
    const seen = new Uint8Array(width * height), output = [];
    for (let start=0; start<seen.length; start++) {
      if (seen[start]) continue;
      seen[start]=1;
      let k=start*4;
      if (!isGreen(data[k],data[k+1],data[k+2], settings) || !data[k+3]) continue;
      const queue=[start]; let minX=width,maxX=0,minY=height,maxY=0,sx=0,sy=0;
      for (let j=0;j<queue.length;j++) {
        const p=queue[j], x=p%width,y=Math.floor(p/width);
        minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);sx+=x;sy+=y;
        for (const [nx,ny] of [[x-1,y],[x+1,y],[x,y-1],[x,y+1]]) {
          if(nx<0||ny<0||nx>=width||ny>=height) continue;
          const n=ny*width+nx;
          if(seen[n]) continue;
          seen[n]=1;k=n*4;
          if(isGreen(data[k],data[k+1],data[k+2],settings)&&data[k+3]) queue.push(n);
        }
      }
      // Ignore isolated noise and broad solid background regions.
      const w=maxX-minX+1,h=maxY-minY+1;
      if(queue.length>=6&&w>=3&&h>=3&&w/h<4&&h/w<4) output.push({x:(minX+maxX)/2,y:(minY+maxY)/2,w,h,pixels:queue.length});
    }
    return output.sort((a,b)=>a.y-b.y||a.x-b.x);
  }
  function delay(min,max,random=Math.random) {return Math.round((min+random()*(max-min))*1000);}
  function sameLayout(a,b) {
    return !!a && !!b && a.path===b.path && Math.abs(a.width/b.width-1)<0.04 && Math.abs(a.height/b.height-1)<0.04;
  }
  function webhook(value) {
    if(!value) return '';
    const u=new URL(value);
    const entries=queryParts(u.search);
    if(!['https://discord.com','https://discordapp.com','https://ptb.discord.com','https://canary.discord.com'].includes(u.origin)||!/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_-]+\/?$/.test(u.pathname)||entries.some(p=>!['wait','thread_id'].includes(p.key))||u.hash) throw Error('Enter the Discord webhook URL copied from your channel settings.');
    if(u.hostname!=='discord.com')u.hostname='discord.com';
    u.search=entries.filter(p=>p.key!=='wait').map(p=>p.raw).join('&');
    return u.href;
  }
  // Avoid WebIDL iterator wrappers in Firefox content-script compartments.
  function queryParts(search){
    return String(search).replace(/^\?/,'').split('&').filter(Boolean).map(raw=>{
      const encoded=raw.split('=',1)[0];let key;
      try{key=decodeURIComponent(encoded.replace(/\+/g,' '));}catch{key=encoded;}
      return {key,raw};
    });
  }
  function pageKey(value){
    const u=new URL(value);u.hash='';
    const parts=queryParts(u.search).filter(p=>!/^(token|session|sessionid|sid|ts|timestamp|t|nonce|utm_.*|_.*)$/i.test(p.key));
    parts.sort((a,b)=>a.key.localeCompare(b.key)||a.raw.localeCompare(b.raw));
    return u.origin+u.pathname+(parts.length?'?'+parts.map(p=>p.raw).join('&'):'');
  }
  function actionDelay(base,random=Math.random){return base+Math.floor(random()*801)+150;}
  function firstGreen(data,width,settings=defaults.green){
    for(let i=0;i<data.length;i+=4)if(isGreen(data[i],data[i+1],data[i+2],settings))return {x:(i/4)%width+5,y:Math.floor(i/4/width)+5};
    return null;
  }
  function countdown(deadline,now=Date.now()){return Math.max(0,Math.ceil((deadline-now)/1000));}
  function shortCountdown(deadline,now=Date.now()){const seconds=Math.max(0,(deadline-now)/1000);return seconds<1?seconds.toFixed(1):String(Math.ceil(seconds));}
  function copyProfile(source,id){return validateProfile({...source,id,name:`${source.name} copy`,zones:[],layout:undefined,discordTest:undefined});}
  globalThis.BMS={defaults,validateProfile,isGreen,components,delay,sameLayout,webhook,pageKey,countdown,shortCountdown,copyProfile,actionDelay,firstGreen};
  if(typeof module!=='undefined') module.exports=globalThis.BMS;
})();
