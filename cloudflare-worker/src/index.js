import tropicalWatch from './tropical-watch.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Max-Age': '86400'
};
const json = (data, status=200, extra={}) => new Response(JSON.stringify(data), {status, headers:{...CORS,'Content-Type':'application/json; charset=utf-8',...extra}});

async function aviation(req,url){
  const qs=url.searchParams;
  if(qs.get('nearby')==='true'){
    const lat=Number(qs.get('lat')),lon=Number(qs.get('lon'));
    if(!Number.isFinite(lat)||lat < -90||lat>90||!Number.isFinite(lon)||lon < -180||lon>180) return json({ok:false,error:'Valid lat and lon coordinates are required.'},400);
    try{const observation=await nearestMetar(lat,lon);return json({ok:!!observation,observation,message:observation?undefined:'No recent METAR observation was found within 200 km.',source:'AviationWeather.gov global METAR cache',retrievedAt:new Date().toISOString() },200,{'Cache-Control':'public, max-age=60'});}catch(e){return json({ok:false,error:'Nearby METAR lookup failed.',detail:String(e.message||e)},502);}
  }
  const ids=[...new Set((qs.get('ids')||'').toUpperCase().split(/[\s,;]+/).map(x=>x.trim()).filter(x=>/^[A-Z]{4}$/.test(x)))].slice(0,20);
  const hours=Math.max(0,Math.min(96,parseInt(qs.get('hours')||'0',10)||0));const includeTaf=(qs.get('taf')||'false').toLowerCase()==='true';
  if(!ids.length)return json({error:'Provide one or more valid 4-letter ICAO identifiers.'},400);
  const base='https://aviationweather.gov/api/data';const headers={'Accept':'application/json','User-Agent':'VayuSarathi/1.0 METAR-TAF dashboard'};
  try{
    const metarUrl=`${base}/metar?ids=${encodeURIComponent(ids.join(','))}&format=json${hours?`&hoursBeforeNow=${hours}`:''}`;
    let mr=await fetch(metarUrl,{headers});if(hours&&mr.status===400)mr=await fetch(`${base}/metar?ids=${encodeURIComponent(ids.join(','))}&format=json&hours=${hours}`,{headers});
    if(mr.status===204)mr=new Response('[]',{status:200});if(!mr.ok)throw Error(`METAR request returned HTTP ${mr.status}`);
    const metars=await mr.json();let tafs=[];
    if(includeTaf){const tr=await fetch(`${base}/taf?ids=${encodeURIComponent(ids.join(','))}&format=json`,{headers});if(tr.status!==204){if(!tr.ok)throw Error(`TAF request returned HTTP ${tr.status}`);tafs=await tr.json();}}
    const tmap=new Map((Array.isArray(tafs)?tafs:[]).map(x=>[String(x.icaoId||x.icao||'').toUpperCase(),x]));const mmap=new Map();
    for(const m of (Array.isArray(metars)?metars:[])){const id=String(m.icaoId||m.icao||'').toUpperCase();if(!id)continue;if(!mmap.has(id))mmap.set(id,[]);mmap.get(id).push({...m,icaoId:m.icaoId||m.icao||'',rawOb:m.rawOb||m.raw_text||'',flightCategory:m.fltCat||m.flightCategory||'',stationName:m.stationName||m.name||''});}
    const reports=ids.map(icao=>{const list=(mmap.get(icao)||[]).sort((a,b)=>Number(b.obsTime||0)-Number(a.obsTime||0));const taf=tmap.get(icao);return{icao,metars:list,metar:list[0]||null,tafData:taf?{...taf,icaoId:taf.icaoId||taf.icao||'',rawTAF:taf.rawTAF||taf.raw_text||taf.forecast||''}:null,error:(!list.length&&!taf&&includeTaf)?'No METAR or TAF was returned for this identifier in the selected request.':(!list.length?'No METAR observation was returned for this identifier in the selected time window.':undefined)}});
    return json({ok:true,requested:ids,hours,includeTaf,reports,source:'AviationWeather.gov Data API',retrievedAt:new Date().toISOString()},200,{'Cache-Control':'public, max-age=15'});
  }catch(e){return json({error:'Aviation weather upstream request failed.',detail:String(e.message||e)},502);}
}
function csvLine(line){const out=[];let v='',q=false;for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(q&&line[i+1]==='"'){v+='"';i++;}else q=!q;}else if(c===','&&!q){out.push(v);v='';}else v+=c;}out.push(v);return out;}
function hav(lat1,lon1,lat2,lon2){const r=x=>x*Math.PI/180,dl=r(lat2-lat1),dn=r(lon2-lon1),a=Math.sin(dl/2)**2+Math.cos(r(lat1))*Math.cos(r(lat2))*Math.sin(dn/2)**2;return 6371*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));}
async function gunzipText(buffer){const ds=new DecompressionStream('gzip');const stream=new Blob([buffer]).stream().pipeThrough(ds);return await new Response(stream).text();}
function parseMetarSlpHpa(rawText){
  const m=String(rawText||'').toUpperCase().match(/(?:^|\s)SLP(\d{3})(?=\s|=|$)/);
  if(!m)return null;const code=Number(m[1]);return code<=499?1000+code/10:900+code/10;
}
function metarCloudCoverPercent(...values){
  const text=values.flat(Infinity).filter(v=>v!==null&&v!==undefined&&String(v).trim()).map(v=>typeof v==='object'?(v.cover||v.amount||v.code||''):String(v)).join(' ').toUpperCase();
  if(!text)return null;
  const codes=text.match(/(?:^|\s)(FEW|SCT|BKN|OVC|VV|SKC|CLR|NSC|NCD|CAVOK)(?=\d{3}|\s|$)/g)||[];
  if(!codes.length)return null;
  const map={FEW:19,SCT:44,BKN:75,OVC:100,VV:100,SKC:0,CLR:0,NCD:0};
  const valuesPct=codes.map(c=>map[c.trim()]).filter(v=>v!==undefined);
  // NSC/CAVOK do not prove that total-sky cover is zero, so do not score them as clear.
  if(!valuesPct.length)return null;
  return Math.max(...valuesPct);
}
async function nearestMetar(lat,lon){
  const r=await fetch('https://aviationweather.gov/data/cache/metars.cache.csv.gz',{headers:{'Accept':'application/gzip, text/csv, */*','User-Agent':'VayuSarathi/1.0 observation-calibration'}});
  if(!r.ok)throw Error(`Global METAR cache returned HTTP ${r.status}`);
  const buf=await r.arrayBuffer();let csv;try{csv=await gunzipText(buf);}catch{csv=new TextDecoder().decode(buf);}
  const lines=csv.split(/\r?\n/).filter(x=>x.trim());
  const hi=lines.findIndex(line=>/station_id/i.test(line)&&/latitude/i.test(line)&&/longitude/i.test(line));
  if(hi<0)throw Error('Could not identify columns in global METAR cache.');
  const h=csvLine(lines[hi]).map(x=>x.trim().toLowerCase().replace(/^\uFEFF/,''));
  const idx=(...names)=>{for(const n of names){const i=h.indexOf(n.toLowerCase());if(i>=0)return i;}return -1;};
  const get=(row,...names)=>{const i=idx(...names);return i<0?'':String(row[i]??'').trim();};
  const num=(row,...names)=>{const s=get(row,...names),n=parseFloat(s);return s&&Number.isFinite(n)?n:null;};
  const ti=idx('observation_time','obstime','obs_time'),si=idx('station_id','icao_id','icao'),li=idx('latitude','lat'),oi=idx('longitude','lon');
  if([ti,si,li,oi].some(x=>x<0))throw Error('Required station/time/coordinate columns are missing.');
  const now=Date.now();let best=null;
  for(let i=hi+1;i<lines.length;i++){
    const row=csvLine(lines[i]);if(row.length<h.length)continue;
    const slat=parseFloat(row[li]),slon=parseFloat(row[oi]),t=Date.parse(row[ti]||'');
    if(!Number.isFinite(slat)||!Number.isFinite(slon)||!Number.isFinite(t)||t>now+10*60*1000||now-t>3*3600*1000)continue;
    const d=hav(lat,lon,slat,slon);if(d>200||(best&&d>=best.distanceKm))continue;
    const vis=num(row,'visibility_statute_mi','visibility','visib');
    const alt=num(row,'altim_in_hg','altimeter_in_hg','altim');
    const rawText=get(row,'raw_text','rawob','raw_ob');
    const slp=num(row,'sea_level_pressure_mb','mslp','slp')??parseMetarSlpHpa(rawText);
    const weather=get(row,'wx_string','present_weather','weather');
    const clouds=get(row,'sky_condition','sky_cover','clouds');
    best={
      icao:get(row,'station_id','icao_id','icao'),stationName:get(row,'station_name','name','station'),
      latitude:slat,longitude:slon,distanceKm:Math.round(d*10)/10,observationTime:new Date(t).toISOString(),
      tempC:num(row,'temp_c','temperature_c','tmpc'),dewC:num(row,'dewpoint_c','dew_point_c','dwpc'),
      windDirection:num(row,'wind_dir_degrees','wind_direction_degrees','drct'),
      windSpeedKt:num(row,'wind_speed_kt','wind_speed_kts','sknt'),windGustKt:num(row,'wind_gust_kt','wind_gust_kts','gust'),
      visibilitySM:vis,visibilityM:vis==null?null:vis*1609.344,
      // Keep QNH/altimeter setting separate from model mean-sea-level pressure.
      altimeterHpa:alt==null?null:alt*33.8638866667,seaLevelPressureHpa:slp,
      weather,clouds,cloudCoverPct:metarCloudCoverPercent(clouds,rawText),
      cloudCoverMethod:metarCloudCoverPercent(clouds,rawText)==null?null:'METAR cloud-group midpoint estimate',
      flightCategory:get(row,'flight_category','fltcat'),rawText
    };
  }
  return best;
}

const params=['temperature_2m','wind_speed_10m','visibility','pressure_msl','cloud_cover'];
const sources=['gfs','ecmwf','icon','openMeteo','vayuSarathi'];
const validationSplit=0.20;
const thresholds={experimental:500,operationalReview:2000,validationExperimental:100,validationOperational:400,daysExperimental:30,daysOperational:60};
function keyHour(t){const d=new Date(t);return Number.isFinite(d.getTime())?d.toISOString().slice(0,13):String(t);}
function keySnapshot(s){return `snapshots/${Number(s.location.lat).toFixed(3)}_${Number(s.location.lon).toFixed(3)}/${String(s.issuedAt).replace(/[:.]/g,'-')}.json`;}
function mae(a){const v=a.filter(Number.isFinite);return v.length?v.reduce((s,x)=>s+Math.abs(x),0)/v.length:null;}
function rmse(a){const v=a.filter(Number.isFinite);return v.length?Math.sqrt(v.reduce((s,x)=>s+x*x,0)/v.length):null;}
function biasMean(a){const v=a.filter(Number.isFinite);return v.length?v.reduce((s,x)=>s+x,0)/v.length:null;}
function errFor(p,f,o){if(!Number.isFinite(f)||!Number.isFinite(o))return null;if(p==='visibility')return(f-o)/1000;return f-o;}
function wxForecast(c){
  if(c===null||c===undefined||c===''||!Number.isFinite(Number(c)))return null;
  const n=Number(c);
  return{
    thunderstorm:[95,96,98,99].includes(n),
    rain:[51,53,55,56,57,61,63,65,66,67,80,81,82].includes(n),
    fog:[45,48].includes(n),
    snow:[71,73,75,77,85,86].includes(n),
    freezing:[56,57,66,67].includes(n),
    // WMO present-weather codes: 06-09 and 30-35 are dust/sand events; 98 is TS+dust.
    dust:[6,7,8,9,30,31,32,33,34,35,98].includes(n)
  };
}
function wxObs(value){
  const raw=String(value??'').trim().toUpperCase();if(!raw)return null;
  const tokens=raw.match(/[A-Z]{2,8}/g)||[];
  const hasEnd=(...codes)=>tokens.some(t=>codes.some(c=>t===c||t.endsWith(c)));
  const hasStart=(...codes)=>tokens.some(t=>codes.some(c=>t===c||t.startsWith(c)));
  return{
    thunderstorm:hasStart('TS')||tokens.includes('VCTS'),
    rain:hasEnd('RA','DZ')||tokens.includes('SHRA')||tokens.includes('SHSN'),
    fog:hasEnd('FG')||tokens.includes('BR'),
    snow:hasEnd('SN','SG','PL'),
    freezing:hasStart('FZ'),
    // HZ (haze) is deliberately excluded: it is not a dust/sand event code.
    dust:tokens.includes('DU')||tokens.includes('SA')||tokens.includes('DS')||tokens.includes('SS')||tokens.includes('PO')||hasEnd('DU','SA')
  };
}
async function listKV(env,prefix){const all=[];let cursor;do{const res=await env.VERIFICATION_KV.list({prefix,cursor,limit:1000});all.push(...res.keys);cursor=res.list_complete?undefined:res.cursor;}while(cursor);return all;}
async function getJSON(env,key){const v=await env.VERIFICATION_KV.get(key);if(!v)return null;try{return JSON.parse(v);}catch{return null;}}
function forecastValue(f,p,s){
  if(s==='gfs')return f.models?.gfs?.[p];
  if(s==='ecmwf')return f.models?.ecmwf?.[p];
  if(s==='icon')return f.models?.icon?.[p];
  if(s==='openMeteo')return f.openMeteo?.[p];
  return f.vayuSarathi?.[p];
}
function parameterMetrics(records){
  const clean=records.filter(x=>Number.isFinite(x.time)&&Number.isFinite(x.error)).sort((a,b)=>a.time-b.time);
  const days=[...new Set(clean.map(x=>new Date(x.time).toISOString().slice(0,10)))].sort();
  // Split on whole UTC dates so one day's cases cannot leak across train/holdout.
  const holdoutDayCount=days.length?Math.max(1,Math.ceil(days.length*validationSplit)):0;
  const holdoutDays=new Set(days.slice(-holdoutDayCount));
  const holdout=clean.filter(x=>holdoutDays.has(new Date(x.time).toISOString().slice(0,10)));
  const training=clean.filter(x=>!holdoutDays.has(new Date(x.time).toISOString().slice(0,10)));
  const cases=clean.length,validationCases=holdout.length,distinctDays=days.length,validationDays=holdoutDays.size;
  const experimentalSampleReady=cases>=thresholds.experimental&&validationCases>=thresholds.validationExperimental&&distinctDays>=thresholds.daysExperimental;
  const operationalReviewSampleReady=cases>=thresholds.operationalReview&&validationCases>=thresholds.validationOperational&&distinctDays>=thresholds.daysOperational;
  return{
    mae:mae(clean.map(x=>x.error)),rmse:rmse(clean.map(x=>x.error)),bias:biasMean(clean.map(x=>x.error)),cases,
    trainingCases:training.length,validationCases,distinctDays,validationDays,
    validationMae:mae(holdout.map(x=>x.error)),validationRmse:rmse(holdout.map(x=>x.error)),validationBias:biasMean(holdout.map(x=>x.error)),
    experimentalSampleReady,operationalReviewSampleReady,
    // A correction candidate has not yet been trained/scored; sample readiness alone never activates it.
    holdoutImprovementPercent:null,qualityPassed:false
  };
}
async function verification(req,url,env){
  try{
    if(!env.VERIFICATION_KV)return json({ok:false,error:'VERIFICATION_KV binding is not configured.'},503);
    if(req.method==='POST'){
      let b;try{b=await req.json();}catch{return json({ok:false,error:'Invalid JSON request.'},400);}
      if(b.action==='snapshot'){
        if(!b.snapshot?.location||!Array.isArray(b.snapshot.rows))return json({ok:false,error:'Invalid forecast snapshot.'},400);
        const s=b.snapshot,key=keySnapshot(s);await env.VERIFICATION_KV.put(key,JSON.stringify(s));return json({ok:true,key,modified:true});
      }
      if(b.action==='match'){
        if(!b.location||!b.validTime||!b.forecast||!b.observation)return json({ok:false,error:'Invalid verification match.'},400);
        const lat=Number(b.location.lat),lon=Number(b.location.lon);
        if(!Number.isFinite(lat)||!Number.isFinite(lon))return json({ok:false,error:'Invalid match location.'},400);
        const key=`matches/${lat.toFixed(3)}_${lon.toFixed(3)}/${keyHour(b.validTime)}.json`;
        const match={schemaVersion:2,location:{name:b.location.name||'Selected location',lat,lon},validTime:b.validTime,observation:b.observation,station:b.station||{},forecast:b.forecast};
        await env.VERIFICATION_KV.put(key,JSON.stringify(match));return json({ok:true,key,modified:true});
      }
      return json({ok:false,error:'Unknown verification action.'},400);
    }
    const snapsKeys=await listKV(env,'snapshots/');const snapshots=[];
    for(const k of snapsKeys){const s=await getJSON(env,k.name);if(s)snapshots.push({key:k.name,snapshot:s});}
    snapshots.sort((a,b)=>String(a.snapshot.issuedAt||'').localeCompare(String(b.snapshot.issuedAt||'')));
    if(url.searchParams.get('action')==='snapshots')return json({ok:true,snapshots:snapshots.slice(-100).map(x=>x.snapshot)});
    const matchKeys=await listKV(env,'matches/');const matches=[];
    for(const k of matchKeys){const m=await getJSON(env,k.name);if(m)matches.push(m);}
    const numberOrNull=value=>value===null||value===undefined||value===''?null:(Number.isFinite(Number(value))?Number(value):null);
    const parameterRecords={};for(const p of params){parameterRecords[p]={};for(const s of sources)parameterRecords[p][s]=[];}
    for(const m of matches){
      const f=m.forecast||{},o=m.observation||{};
      const time=Date.parse(m.validTime||m.station?.observationTime||'');if(!Number.isFinite(time))continue;
      for(const p of params){
        const observed=numberOrNull(o[p]);if(observed===null)continue;
        for(const s of sources){const forecast=numberOrNull(forecastValue(f,p,s));if(forecast===null)continue;const error=errFor(p,forecast,observed);if(error!==null)parameterRecords[p][s].push({time,error});}
      }
    }
    const events={thunderstorm:{hits:0,misses:0,falseAlarms:0,correctNegatives:0,cases:0},rain:{hits:0,misses:0,falseAlarms:0,correctNegatives:0,cases:0},fog:{hits:0,misses:0,falseAlarms:0,correctNegatives:0,cases:0},snow:{hits:0,misses:0,falseAlarms:0,correctNegatives:0,cases:0},freezing:{hits:0,misses:0,falseAlarms:0,correctNegatives:0,cases:0},dust:{hits:0,misses:0,falseAlarms:0,correctNegatives:0,cases:0}};
    for(const m of matches){
      const fc=m.forecast?.vayuSarathi?.weather_code??m.forecast?.openMeteo?.weather_code??m.forecast?.weather_code;
      const f=wxForecast(fc),o=wxObs([m.observation?.weather_text,m.observation?.wx_string,m.observation?.raw_metar].filter(Boolean).join(' '));
      // Missing observed weather text is unknown, not a correct negative.
      if(!f||!o)continue;
      for(const k of Object.keys(f)){const x=events[k];x.cases++;if(f[k]&&o[k])x.hits++;else if(!f[k]&&o[k])x.misses++;else if(f[k]&&!o[k])x.falseAlarms++;else x.correctNegatives++;}
    }
    const stats={snapshots:snapshots.length,matchedCases:matches.length,parameters:{},best:{},bestHoldout:{},weatherEvents:events,qualityGates:{}};
    for(const p of params){
      stats.parameters[p]={cases:0};stats.qualityGates[p]={};let bestMae=Infinity,bestSrc=null,bestValMae=Infinity,bestValSrc=null;
      for(const s of sources){
        const metric=parameterMetrics(parameterRecords[p][s]);stats.parameters[p][s]=metric;
        stats.qualityGates[p][s]={cases:metric.cases,trainingCases:metric.trainingCases,validationCases:metric.validationCases,distinctDays:metric.distinctDays,validationDays:metric.validationDays,experimentalSampleReady:metric.experimentalSampleReady,operationalReviewSampleReady:metric.operationalReviewSampleReady,holdoutImprovementPercent:null,qualityPassed:false};
        if(metric.mae!==null&&metric.mae<bestMae){bestMae=metric.mae;bestSrc=s;}
        if(metric.validationMae!==null&&metric.validationMae<bestValMae){bestValMae=metric.validationMae;bestValSrc=s;}
      }
      stats.parameters[p].cases=Math.max(...sources.map(s=>stats.parameters[p][s].cases),0);
      if(bestSrc)stats.best[p]={source:bestSrc,mae:bestMae};
      if(bestValSrc)stats.bestHoldout[p]={source:bestValSrc,mae:bestValMae};
    }
    stats.best.temperature=stats.best.temperature_2m||{source:null,mae:null};
    stats.best.wind=stats.best.wind_speed_10m||{source:null,mae:null};
    return json({ok:true,stats,learning:{
      thresholdExperimental:thresholds.experimental,thresholdOperational:thresholds.operationalReview,
      validationSplit,minimumValidationCasesExperimental:thresholds.validationExperimental,minimumValidationCasesOperational:thresholds.validationOperational,
      minimumDistinctDaysExperimental:thresholds.daysExperimental,minimumDistinctDaysOperational:thresholds.daysOperational,
      minimumSkillImprovementPercent:5,holdoutMethod:'chronological UTC date-blocked 20% holdout',
      sampleGatesArePerParameterAndSource:true,correctionsEnabled:false,correctionSkillEvaluation:'not yet implemented; no operational correction is activated',
      qualityNote:'Thresholds only permit offline review. Operational correction remains disabled until a candidate is evaluated on untouched chronological holdout data, improves holdout MAE by at least 5%, and does not degrade critical aviation-weather event scores.',
      method:'forecast-error verification and offline refinement readiness'
    }});
  }catch(e){return json({ok:false,error:'Verification service failed.',detail:String(e.message||e)},500);}
}
async function verificationHealth(env){try{if(!env.VERIFICATION_KV)throw Error('VERIFICATION_KV binding is not configured.');const key='_health/verification.json';if(!await env.VERIFICATION_KV.get(key))await env.VERIFICATION_KV.put(key,JSON.stringify({ok:true,createdAt:new Date().toISOString()}));return json({ok:true,service:'vayusarathi-verification',kv:true,time:new Date().toISOString()},200);}catch(e){return json({ok:false,error:'Verification backend is unavailable.',detail:String(e.message||e)},503);}}

async function cronCollector(env){
  if(!env.VERIFICATION_KV)throw Error('VERIFICATION_KV binding is not configured.');
  const keys=await listKV(env,'snapshots/');const locs=new Map();
  for(const k of keys){const s=await getJSON(env,k.name);if(s?.location)locs.set(`${Number(s.location.lat).toFixed(3)}_${Number(s.location.lon).toFixed(3)}`,s);}
  if(!locs.size)return 'No forecast snapshots yet.';
  const r=await fetch('https://aviationweather.gov/data/cache/metars.cache.csv.gz',{headers:{'User-Agent':'VayuSarathi/1.0 Forecast Verification Collector'}});
  if(!r.ok)throw Error(`METAR cache HTTP ${r.status}`);
  const rawBytes=await r.arrayBuffer();let csv;try{csv=await gunzipText(rawBytes);}catch(e){csv=new TextDecoder().decode(rawBytes);}
  const lines=csv.split(/\r?\n/).filter(Boolean);const hi=lines.findIndex(x=>/station_id/i.test(x)&&/latitude/i.test(x)&&/longitude/i.test(x));
  if(hi<0)throw Error('METAR cache header missing');
  const h=csvLine(lines[hi]).map(x=>x.trim().toLowerCase());
  const idx=(...names)=>{for(const n of names){const i=h.indexOf(n);if(i>=0)return i;}return -1;};
  const get=row=> (...names)=>{for(const name of names){const i=idx(name);if(i>=0&&row[i]!=null&&String(row[i]).trim()!=='')return String(row[i]).trim();}return '';};
  const n=v=>{const x=parseFloat(v);return Number.isFinite(x)?x:null;};const obs=[];
  for(let i=hi+1;i<lines.length;i++){
    const row=csvLine(lines[i]),g=get(row),lat=n(g('latitude','lat')),lon=n(g('longitude','lon'));
    const t=Date.parse(g('observation_time','obs_time','obstime')||'');
    if(lat==null||lon==null||!Number.isFinite(t)||Math.abs(Date.now()-t)>2.5*3600*1000)continue;
    const vis=n(g('visibility_statute_mi','visibility','visib'));
    const alt=n(g('altim_in_hg','altimeter_in_hg','altim'));
    const rawText=g('raw_text','rawob','raw_ob');
    const slp=n(g('sea_level_pressure_mb','mslp','slp'))??parseMetarSlpHpa(rawText);
    const wx=g('wx_string','present_weather','weather');
    const clouds=g('sky_condition','sky_cover','clouds');const cloudCover=metarCloudCoverPercent(clouds,rawText);
    obs.push({
      icao:g('station_id','icao_id','icao'),lat,lon,observationTime:new Date(t).toISOString(),
      tempC:n(g('temp_c','temperature_c','tmpc')),windSpeedKt:n(g('wind_speed_kt','wind_speed_kts','sknt')),
      windDirection:n(g('wind_dir_degrees','wind_direction_degrees','drct')),
      visibilityM:vis==null?null:vis*1609.344,altimeterHpa:alt==null?null:alt*33.8638866667,
      seaLevelPressureHpa:slp,cloudCoverPct:cloudCover,wxString:wx,rawText
    });
  }
  let matched=0,processed=0;
  for(const s of [...locs.values()].slice(0,100)){
    let row=null,best=Infinity;
    for(const x of s.rows||[]){const d=Math.abs(new Date(x.validTime).getTime()-Date.now());if(d<best){best=d;row=x;}}
    if(!row||best>35*60*1000)continue;
    let ob=null,dist=Infinity;
    for(const m of obs){const d=hav(s.location.lat,s.location.lon,m.lat,m.lon);if(d<dist&&d<=200){dist=d;ob=m;}}
    if(!ob)continue;
    const key=`matches/${Number(s.location.lat).toFixed(3)}_${Number(s.location.lon).toFixed(3)}/${keyHour(row.validTime)}.json`;
    if(await env.VERIFICATION_KV.get(key)){processed++;continue;}
    const weatherText=[ob.wxString,ob.rawText].filter(Boolean).join(' ');
    const observation={
      temperature_2m:ob.tempC,wind_speed_10m:ob.windSpeedKt,wind_direction_10m:ob.windDirection,
      visibility:ob.visibilityM,pressure_msl:ob.seaLevelPressureHpa,cloud_cover:ob.cloudCoverPct,
      cloud_cover_method:ob.cloudCoverPct==null?null:'METAR cloud-group midpoint estimate',weather_text:weatherText,
      // Altimeter setting is stored separately and is never compared to model pressure_msl.
      altimeter_setting_hpa:ob.altimeterHpa
    };
    await env.VERIFICATION_KV.put(key,JSON.stringify({schemaVersion:2,location:s.location,validTime:row.validTime,observation,station:{icao:ob.icao,distanceKm:Math.round(dist*10)/10,observationTime:ob.observationTime},forecast:row}));
    matched++;processed++;
  }
  return `Verification collector processed ${processed} locations and created ${matched} new matches.`;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/$/, '') || '/';

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      // Friendly root health response for opening the Worker URL directly.
      if (path === '/' || path === '/health' || path === '/api/health') {
        return json({
          ok: true,
          service: 'VayuSarathi API',
          status: 'online',
          functions: ['METAR/TAF', 'Tropical Watch', 'Forecast Validation'],
          routes: [
            '/api/aviation',
            '/api/tropical-watch',
            '/api/verification',
            '/api/verification-health'
          ],
          time: new Date().toISOString()
        });
      }

      if (path === '/api/aviation') {
        if (req.method !== 'GET') return json({ ok: false, error: 'Method not allowed.' }, 405);
        return aviation(req, url);
      }

      if (path === '/api/tropical-watch') {
        if (req.method !== 'GET') return json({ ok: false, error: 'Method not allowed.' }, 405);
        const result = await tropicalWatch();
        return new Response(result.body, {
          status: result.statusCode || 200,
          headers: { ...CORS, ...result.headers }
        });
      }

      if (path === '/api/verification') {
        if (!['GET', 'POST'].includes(req.method)) return json({ ok: false, error: 'Method not allowed.' }, 405);
        return verification(req, url, env);
      }

      if (path === '/api/verification-health') {
        if (req.method !== 'GET') return json({ ok: false, error: 'Method not allowed.' }, 405);
        return verificationHealth(env);
      }

      return json({
        ok: false,
        error: 'Route not found',
        routes: [
          '/api/aviation (METAR/TAF)',
          '/api/tropical-watch',
          '/api/verification',
          '/api/verification-health',
          '/api/health'
        ]
      }, 404);
    } catch (error) {
      console.error('VayuSarathi Worker error:', error);
      return json({ ok: false, error: String(error?.message || error) }, 500);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      cronCollector(env)
        .then(message => console.log(message))
        .catch(error => console.error('VayuSarathi verification collector failed:', error))
    );
  }
};
