const USER_AGENT='VayuSarathi/1.0 Tropical System Watch';
const SOURCES={
  // Tier 1: IMD / RSMC New Delhi. The cyclone-information page is the
  // primary live source and is polled on every watch refresh. IMD's cyclone
  // service also publishes hourly bulletins during active tropical cyclones.
  imdHourly:'https://mausam.imd.gov.in/responsive/cycloneinformation.php?lang=en',
  imdHourlyArchive:'https://mausam.imd.gov.in/responsive/cyclone_bulletin_archive.php',
  imdBhubaneswar:'https://mausam.imd.gov.in/Forecast/coastal_bulletin_new.php?id=5',
  imdChennai:'https://mausam.imd.gov.in/Forecast/coastal_bulletin_new.php?id=6',
  imdKolkataSea:'https://mausam.imd.gov.in/Forecast/seaarea_bulletin_new.php?id=0',
  rsmc:'https://rsmcnewdelhi.imd.gov.in/',
  // Tier 2: independent/secondary operational sources. These are used only
  // when the primary IMD layer is unavailable, or as corroboration.
  wmo:'https://wwmiws.wmo.int/index.php/metareas/bulletinset/8N/html'
};
const BASINS={
  'Bay of Bengal':{lat:[8,11,14,17,20],lon:[80,83.5,87,90.5,94]},
  'Arabian Sea':{lat:[8,11,14,17,20],lon:[52,56,60,64,68,72]}
};
const MODELS=[
  {id:'gfs',name:'GFS',url:'https://api.open-meteo.com/v1/gfs'},
  {id:'ecmwf',name:'ECMWF',url:'https://api.open-meteo.com/v1/ecmwf'},
  {id:'icon',name:'ICON',url:'https://api.open-meteo.com/v1/dwd-icon'}
];
function escText(s){return String(s||'').replace(/\s+/g,' ').trim();}
function finite(v){return v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v));}
function hav(a,b,c,d){const r=x=>x*Math.PI/180,dl=r(c-a),dn=r(d-b);const q=Math.sin(dl/2)**2+Math.cos(r(a))*Math.cos(r(c))*Math.sin(dn/2)**2;return 6371*2*Math.atan2(Math.sqrt(q),Math.sqrt(1-q));}
function buildPoints(cfg){const out=[];for(const lat of cfg.lat)for(const lon of cfg.lon)out.push({lat,lon});return out;}
function apiUrl(base,points){
  const vars='pressure_msl,precipitation,cape,relative_humidity_700hPa,wind_speed_850hPa,wind_direction_850hPa,wind_speed_200hPa,wind_direction_200hPa';
  return base+'?latitude='+points.map(p=>p.lat).join(',')+'&longitude='+points.map(p=>p.lon).join(',')+'&hourly='+encodeURIComponent(vars)+'&forecast_hours=120&timezone=UTC&wind_speed_unit=kn&cell_selection=sea';
}
async function fetchJson(url){const r=await fetch(url,{headers:{'User-Agent':USER_AGENT,'Accept':'application/json'}});if(!r.ok)throw Error('HTTP '+r.status+' from '+new URL(url).hostname);return r.json();}
function normalizeMulti(j,points){if(Array.isArray(j))return j;if(Array.isArray(j?.hourly))return [j];if(Array.isArray(j?.latitude))return j.latitude.map((_,i)=>({latitude:j.latitude[i],longitude:j.longitude?.[i],hourly:j.hourly?.[i]}));return points.map((p,i)=>j?.[i]||null);}
function val(h,k,i){const a=h?.[k];if(!Array.isArray(a)||a[i]===null||a[i]===undefined||a[i]==='')return null;const n=Number(a[i]);return Number.isFinite(n)?n:null;}
function median(a){const x=a.filter(finite).map(Number).sort((a,b)=>a-b);if(!x.length)return null;const m=Math.floor(x.length/2);return x.length%2?x[m]:(x[m-1]+x[m])/2;}
function cleanOfficialText(raw){
  return String(raw||'')
    .replace(/<script\b[\s\S]*?<\/script>/gi,' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi,' ')
    .replace(/<!--([\s\S]*?)-->/g,' ')
    .replace(/&nbsp;|&#160;|&#xA0;/gi,' ')
    .replace(/&ldquo;|&#8220;|&#x201c;/gi,'“')
    .replace(/&rdquo;|&#8221;|&#x201d;/gi,'”')
    .replace(/&quot;|&#34;|&#x22;/gi,'"')
    .replace(/&apos;|&#39;|&#x27;/gi,"'")
    .replace(/<[^>]*>/g,' ')
    .replace(/&amp;/gi,'&')
    // Some official bulletin pages contain mojibake/C1 control bytes in place of curly quotes.
    .replace(/[\u0000-\u001F\u007F-\u009F\uFFFD]/g,' ')
    .replace(/\s+/g,' ').trim();
}
function sourceTier(url){
  if(/mausam\.imd\.gov\.in|rsmcnewdelhi\.imd\.gov\.in/i.test(url))return 'IMD/RSMC';
  if(/wwmiws\.wmo\.int/i.test(url))return 'WMO';
  return 'Backup';
}
function parseIssueDate(text){
  const t=String(text||'');
  const patterns=[
    /(\d{1,2}):(\d{2})\s*(?:IST|UTC)\s*(?:OF|on)\s*(\d{1,2})(?:ST|ND|RD|TH)?[\s./-]+([A-Z]{3,9})[\s./-]+(20\d{2})/i,
    /(\d{1,2})(?:ST|ND|RD|TH)?[\s./-]+([A-Z]{3,9})[\s./-]+(20\d{2}).{0,80}?(\d{1,2}):(\d{2})\s*(?:IST|UTC)/i
  ];
  const months={JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};
  for(const re of patterns){
    const m=t.match(re); if(!m)continue;
    let hh,mm,day,mon,year;
    if(re===patterns[0]){hh=Number(m[1]);mm=Number(m[2]);day=Number(m[3]);mon=months[m[4].slice(0,3).toUpperCase()];year=Number(m[5]);}
    else {day=Number(m[1]);mon=months[m[2].slice(0,3).toUpperCase()];year=Number(m[3]);hh=Number(m[4]);mm=Number(m[5]);}
    if(Number.isInteger(mon))return Date.UTC(year,mon,day,hh,mm);
  }
  return null;
}
function parseOfficial(text,sourceUrl){
  const raw=String(text||'');
  const t=cleanOfficialText(raw);
  const upper=t.toUpperCase();
  const active=[];
  const categoryRe=/(SUPER CYCLONIC STORM|EXTREMELY SEVERE CYCLONIC STORM|VERY SEVERE CYCLONIC STORM|SEVERE CYCLONIC STORM|CYCLONIC STORM|DEEP DEPRESSION|DEPRESSION|WELL[- ]MARKED LOW PRESSURE AREA|LOW[- ]PRESSURE AREA)/i;
  const catMatch=upper.match(categoryRe);
  const category=catMatch?catMatch[1].replace(/\s+/g,' ').trim():null;
  const hasCyclo=/(CYCLONIC STORM|DEPRESSION|DEEP DEPRESSION|LOW[- ]PRESSURE AREA)/i.test(t);
  const likely=/(LIKELY TO FORM|LIKELY TO DEVELOP|FORMATION OF.*DEPRESSION|PROBABILITY OF CYCLOGENESIS|DEVELOPMENT OF.*LOW PRESSURE|MAY FORM|FORMATION.*LOW PRESSURE)/i.test(t);

  // Extract a name immediately following a cyclone category. Do not treat bulletin
  // grammar/location words (especially "OVER") as a system name when a bulletin
  // is un-named or its quotation marks are malformed.
  const nonNameWords=new Set(['OVER','AT','IN','ON','NEAR','TO','INTO','WITH','AND','FROM','FOR','AS','IS','WAS','HAS','HAVE','DURING','THE','SAME','BAY','SEA','ARABIAN','NORTH','SOUTH','EAST','WEST','SOUTHWEST','SOUTHEAST','NORTHWEST','NORTHEAST','WESTCENTRAL','EASTCENTRAL','NORTHWESTWARDS','WESTNORTHWESTWARDS','PRONUNCIATION','FORECAST']);
  const namePattern=/(?:SUPER CYCLONIC STORM|EXTREMELY SEVERE CYCLONIC STORM|VERY SEVERE CYCLONIC STORM|SEVERE CYCLONIC STORM|CYCLONIC STORM)\s*[^A-Z0-9]{0,24}([A-Z][A-Z0-9-]{2,})/gi;
  let name=null;
  for(const match of t.matchAll(namePattern)){
    const candidate=match[1].toUpperCase();
    if(!nonNameWords.has(candidate)){name=candidate;break;}
  }

  const posMatch=t.match(/NEAR\s+LATITUDE\s+(\d+(?:\.\d+)?)\s*[°º]?\s*([NS])[^.]{0,120}?LONGITUDE\s+(\d+(?:\.\d+)?)\s*[°º]?\s*([EW])/i);
  const lat=posMatch?(Number(posMatch[1])*(posMatch[2].toUpperCase()==='S'?-1:1)):null;
  const lon=posMatch?(Number(posMatch[3])*(posMatch[4].toUpperCase()==='W'?-1:1)):null;
  const moveMatch=t.match(/MOVED\s+(?:NEARLY\s+)?([A-Z-]+(?:\s+[A-Z-]+)?)\s+WITH(?:\s+A)?\s+SPEED\s+OF\s+(\d+(?:\.\d+)?)\s*KMPH/i);
  const movement=moveMatch?moveMatch[1].replace(/WARDS?$/i,'').toLowerCase().replace(/\b\w/g,c=>c.toUpperCase())+'wards at '+moveMatch[2]+' km/h':null;
  const speedMatch=(t.match(/MAXIMUM\s+SUSTAINED\s+WIND\s+(?:SPEED|SPEEDS)\s+(?:IS|OF|AROUND)?\s*(\d+(?:\s*TO\s*\d+)?)\s*KMPH(?:\s*GUSTING\s*(?:TO|UP TO)?\s*(\d+(?:\s*TO\s*\d+)?)\s*KMPH)?/i) || t.match(/WIND\s+SPEED\s+OF\s*(\d+(?:\s*TO\s*\d+)?)\s*KMPH\s+GUSTING\s+(?:TO|UP TO)?\s*(\d+(?:\s*TO\s*\d+)?)\s*KMPH/i));
  const maxWindKmh=speedMatch?speedMatch[1].replace(/\s+/g,' '):null;
  const gustKmh=speedMatch?.[2]?.replace(/\s+/g,' ')||null;
  const pressureMatch=t.match(/(?:CENTRAL|ESTIMATED\s+CENTRAL)\s+PRESSURE(?:\s+IS\s+AROUND|\s+IS|\s+OF|\s+AROUND)?\s+(\d{3,4}(?:\.\d+)?)\s*HPA/i);
  const pressure=pressureMatch?Number(pressureMatch[1]):null;
  const issueMatch=t.match(/TIME\s+OF\s+ISSUE\s*[|:]?\s*(\d{1,2}:\d{2}\s*IST\s+OF\s+\d{4}-\d{2}-\d{2})/i) || t.match(/TIME\s+OF\s+ISSUE\s*[|:]?\s*([^|]{5,80})/i);
  const issueTime=issueMatch?escText(issueMatch[1]):null;
  let issuedAt=parseIssueDate(t);
  const isoIssue=issueTime&&issueTime.match(/(\d{1,2}):(\d{2})\s*IST\s+OF\s+(\d{4})-(\d{2})-(\d{2})/i);
  if(isoIssue) issuedAt=Date.UTC(Number(isoIssue[3]),Number(isoIssue[4])-1,Number(isoIssue[5]),Number(isoIssue[1]),Number(isoIssue[2]))-19800000;
  const dateMatch=t.match(/(\d{1,2})(?:ST|ND|RD|TH)?\s+([A-Z]+)\s+(20\d{2})/i) || t.match(/(\d{4})-(\d{2})-(\d{2})/);
  const dateText=dateMatch ? (dateMatch[0].includes('-') ? `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}` : `${dateMatch[1]} ${dateMatch[2]} ${dateMatch[3]}`) : null;
  const basin=/BAY OF BENGAL/i.test(t)?'Bay of Bengal':/ARABIAN SEA/i.test(t)?'Arabian Sea':'North Indian Ocean';
  const bulletinTitle=name&&category?`${category} “${name}” over ${basin}`:category?`${category} over ${basin}`:'Official tropical-system bulletin';
  let forecastText='—';
  const forecastSentence=t.match(/(?:IT IS VERY LIKELY TO|IS VERY LIKELY TO|VERY LIKELY TO)\s+MOVE\s+[^.]{20,700}\./i);
  if(forecastSentence) forecastText=escText(forecastSentence[0]);
  const validity=t.match(/BULLETIN\s+VALID\s+FOR\s+12\s+HRS\s+FROM\s+([^|]+?)(?=\s+SYNOPTIC\s+SITUATION|$)/i);
  const synoptic=t.match(/SYNOPTIC\s+SITUATION\s*\|?\s*([^|]{80,900}?)(?=\s+0?IT\s+IS\s+VERY\s+LIKELY|\s+NORTH\s+ODISHA\s+COAST|\s+TIME\s+OF\s+ISSUE|$)/i);
  const synopticText=synoptic?escText(synoptic[1]):null;
  const validityText=validity?escText(validity[1]):null;

  const impactParts=[];
  const surge=t.match(/(?:STORM SURGE|COASTAL INUNDATION)[^.]{0,500}\./i);
  if(surge) impactParts.push(escText(surge[0]));
  const rain=t.match(/(?:HEAVY|VERY HEAVY|EXTREMELY HEAVY)[^.]{0,300}(?:RAIN|RAINFALL)[^.]{0,300}\./i);
  if(rain) impactParts.push(escText(rain[0]));
  const portSignals=[...t.matchAll(/PORT SIGNAL\s*\|?\s*([^|]{10,220}?)(?=\s+TIME\s+OF\s+ISSUE|$)/gi)].slice(0,4).map(m=>escText(m[1]));
  portSignals.forEach(x=>impactParts.push('Port signal: '+x));
  const sea=t.match(/SEA CONDITION\s*\|?\s*([^|]{5,180})/i);
  if(sea) impactParts.push('Sea condition: '+escText(sea[1]));
  const impactText=[...new Set(impactParts)].slice(0,8).join(' ') || 'See the latest official bulletin for rainfall, strong winds, sea-state, fishermen and coastal warnings.';
  const warningText=/(TTT WARNING|CYCLONE WARNING|DISTANT WARNING SIGNAL|GALE|STORM SURGE|COASTAL INUNDATION|FISHERMEN)/i.test(t)?'Official warning/advisory information is present in the latest bulletin.':'No specific warning phrase was extracted from the checked bulletin.';
  const activeLine=category?(category+(name?' '+name:'')):'Official tropical-system information';
  if(hasCyclo)active.push(activeLine);
  const summary=hasCyclo?(name?`${category} “${name}” is active in the ${basin}.`:'Official tropical system information detected'):likely?'Official cyclogenesis/development guidance detected':'No active official tropical-system alert detected';
  return {hasCyclo,likely,high:false,moderate:false,low:false,active:[...new Set(active)],summary,sourceUrl,sourceTier:sourceTier(sourceUrl),category,name,basin,lat,lon,movement,maxWindKmh,gustKmh,pressure,issueTime,issuedAt,dateText,validityText,synopticText,bulletinTitle,forecastText,impactText,warningText,raw:escText(raw).slice(0,30000)};
}

async function fetchOfficial(url,priority){
  try{
    const r=await fetch(url,{headers:{'User-Agent':USER_AGENT,'Accept':'text/html,application/xhtml+xml,text/plain'}});
    if(!r.ok)throw Error('HTTP '+r.status+' from '+new URL(url).hostname);
    const parsed=parseOfficial(await r.text(),url);
    return {...parsed,priority};
  }catch(e){
    return {hasCyclo:false,likely:false,active:[],summary:'Source temporarily unavailable',error:String(e.message||e),sourceUrl:url,sourceTier:sourceTier(url),priority};
  }
}
async function officialLayer(){
  // The IMD cyclone-information page is deliberately first. During an active
  // cyclone IMD publishes hourly bulletins; polling this live layer keeps the
  // dashboard aligned with the latest official update. Coastal/RSMC bulletins
  // corroborate the hourly layer. WMO is the independent backup.
  const primaryUrls=[SOURCES.imdHourly,SOURCES.imdBhubaneswar,SOURCES.imdChennai,SOURCES.imdKolkataSea,SOURCES.rsmc];
  const backupUrls=[SOURCES.wmo];
  const primary=await Promise.all(primaryUrls.map((u,i)=>fetchOfficial(u,i)));
  const primaryHealthy=primary.filter(x=>!x.error);
  const primaryActive=primaryHealthy.filter(x=>x.hasCyclo||x.likely);
  let chosen=null;
  if(primaryActive.length){
    chosen=[...primaryActive].sort((a,b)=>(b.issuedAt||0)-(a.issuedAt||0)||a.priority-b.priority)[0];
  }else if(primaryHealthy.length){
    // A healthy IMD/RSMC primary response saying there is no active system
    // must not be overridden by an older cached/backup storm report.
    chosen=[...primaryHealthy].sort((a,b)=>(b.issuedAt||0)-(a.issuedAt||0)||a.priority-b.priority)[0];
  }else{
    const backups=await Promise.all(backupUrls.map((u,i)=>fetchOfficial(u,10+i)));
    const usable=backups.filter(x=>!x.error&&(x.hasCyclo||x.likely));
    chosen=usable.sort((a,b)=>(b.issuedAt||0)-(a.issuedAt||0)||a.priority-b.priority)[0] || backups.find(x=>!x.error) || backups[0];
  }
  const all=primary.concat(primaryHealthy.length?[]:[]);
  const corroboration=primary.filter(x=>x!==chosen&&x.hasCyclo).map(x=>x.summary);
  const checked=all.map(x=>({url:x.sourceUrl,summary:x.summary,error:x.error||null,issueTime:x.issueTime||null,issuedAt:x.issuedAt||null,tier:x.sourceTier||null,priority:x.priority}));
  return {...chosen,active:[...new Set((chosen?.active||[]).concat(primary.filter(x=>x.hasCyclo).flatMap(x=>x.active||[])))],checkedSources:checked,corroboration,sourceUrl:chosen?.sourceUrl||SOURCES.imdHourly,sourceTier:chosen?.sourceTier||'IMD/RSMC',primaryAvailable:primaryHealthy.length>0,backupUsed:chosen?.sourceTier==='WMO'};
}
function modelPointScores(series,points){
  const times=series[0]?.hourly?.time||[]; const out=[];
  for(let i=0;i<times.length;i++){
    const pvals=series.map(x=>val(x.hourly,'pressure_msl',i)).filter(finite); const med=median(pvals); let best=null;
    for(let k=0;k<series.length;k++){
      const h=series[k]?.hourly; if(!h)continue; const p=val(h,'pressure_msl',i); if(!finite(p))continue;
      const p24=val(h,'pressure_msl',Math.min(i+24,times.length-1)); const fall=finite(p24)?p24-p:null;
      const w850=val(h,'wind_speed_850hPa',i), rh7=val(h,'relative_humidity_700hPa',i), rain=val(h,'precipitation',i), cape=val(h,'cape',i), w200=val(h,'wind_speed_200hPa',i);
      let score=0;
      if(p<1006)score+=1;if(p<1002)score+=1;if(p<998)score+=1;
      if(finite(med)&&p<med-2)score+=1;if(finite(med)&&p<med-5)score+=1;
      if(finite(fall)&&fall<=-2)score+=1;if(finite(fall)&&fall<=-4)score+=1;
      if(finite(w850)&&w850>=15&&w850<=40)score+=1;if(finite(w850)&&w850>=25)score+=1;
      if(finite(rh7)&&rh7>=65)score+=1;if(finite(rain)&&rain>=1)score+=1;if(finite(cape)&&cape>=300)score+=1;
      if(finite(w200)&&w200>=20)score+=1;
      const candidate={index:k,time:times[i],lat:Number(series[k].latitude),lon:Number(series[k].longitude),pressure:p,pressureFall24h:fall,wind850:w850,rh700:rh7,rain,cape,wind200:w200,score};
      if(!best||score>best.score)best=candidate;
    }
    if(best)out.push(best);
  }
  return out;
}
function modelTrack(series){
  const times=series[0]?.hourly?.time||[];
  const track=[];
  for(let i=0;i<times.length;i++){
    let best=null;
    for(let k=0;k<series.length;k++){
      const h=series[k]?.hourly; if(!h)continue;
      const p=val(h,'pressure_msl',i); if(!finite(p))continue;
      const item={time:times[i],lat:Number(series[k].latitude),lon:Number(series[k].longitude),pressure:p,wind850:val(h,'wind_speed_850hPa',i)};
      if(!best||item.pressure<best.pressure)best=item;
    }
    if(best)track.push(best);
  }
  return track.filter((x,i,a)=>i===0 || x.lat!==a[i-1].lat || x.lon!==a[i-1].lon);
}
function bestGuidance(points,basin){
  if(!points.length)return null;
  // Always retain the best model signal for display. Cyclogenesis qualification
  // remains a separate, stricter decision below.
  const ranked=[...points].sort((a,b)=>b.score-a.score || a.pressure-b.pressure);
  const best=ranked[0];
  const eligible=points.filter(x=>x.score>=5 && x.pressure<1008);
  const formation=eligible.length?[...eligible].sort((a,b)=>a.score-b.score||a.pressure-b.pressure).at(-1):null;
  const stronger=eligible.filter(x=>x.score>=7).sort((a,b)=>a.time.localeCompare(b.time));
  const first=stronger[0]||formation;
  const now=Date.now();
  const lead=first?.time?Math.max(0,Math.round((new Date(first.time).getTime()-now)/3600000)):null;
  return {guidance:{...best,basin,formationSignal:!!formation,formationScore:formation?.score??null,formationPressure:formation?.pressure??null,formationLeadHours:lead},candidate:formation?{...formation,firstTime:first.time,leadHours:lead,basin}:null};
}
async function runModel(model,basinName,points){
  const j=await fetchJson(apiUrl(model.url,points)); const arr=normalizeMulti(j,points); const scored=modelPointScores(arr,points); const result=bestGuidance(scored,basinName); const track=modelTrack(arr); return {model,basin:basinName,candidate:result.candidate,guidance:result.guidance,track,points:arr.length};
}
function combine(results){
  const systems=[];
  for(const basin of Object.keys(BASINS)){
    const rr=results.filter(x=>x.basin===basin&&x.candidate); if(!rr.length)continue;
    const support=rr.length; const best=rr.reduce((a,b)=>b.candidate.score>a.candidate.score?b:a); const models=rr.map(x=>x.model.name).join(' + ');
    const leadVals=rr.map(x=>x.candidate.leadHours).filter(Number.isFinite); const lead=Math.min(...leadVals);
    const p=Math.min(...rr.map(x=>x.candidate.pressure));
    const level=support>=3&&best.candidate.score>=8?'orange':support>=2&&best.candidate.score>=6?'yellow':'green';
    let signal=level==='orange'?'Multi-model formation signal':level==='yellow'?'Developing low-pressure signal':'Weak model signal';
    if(best.candidate.wind850>=40&&support>=2)signal='Potential cyclonic-storm strengthening signal';
    else if(best.candidate.wind850>=25&&support>=2)signal='Potential depression-strengthening signal';
    systems.push({basin,signal,level,window:lead<=24?'0–24 h':lead<=48?'24–48 h':lead<=72?'48–72 h':lead<=96?'72–96 h':'96–120 h',models,pressure:p,confidence:support>=3?'High':support===2?'Moderate':'Low',score:best.candidate.score,leadHours:lead});
  }
  return systems;
}
export default async function tropicalWatch(){
  const [official,...modelRuns]=await Promise.all([
    officialLayer(),
    ...Object.entries(BASINS).flatMap(([basin,cfg])=>{const pts=buildPoints(cfg);return MODELS.map(m=>runModel(m,basin,pts).catch(error=>({model:m,basin,candidate:null,error:String(error.message||error)})));})
  ]);
  const systems=combine(modelRuns);
  const officialLevel=official?.hasCyclo?'red':official?.likely?'orange':'green';
  let overall={level:'green',title:'No significant tropical-system signal',window:'—',support:'No multi-model support',message:'No significant formation signal is currently detected by the screened official guidance/NWP layer.'};
  if(official?.hasCyclo){
    const nm=official.name?` “${official.name}”`:'';
    overall={level:'red',title:'Official Tropical System Alert',window:'Active / official guidance',support:'Official source',message:`<b>${official.category||'Tropical system'}${nm}</b> is active over the ${official.basin||'North Indian Ocean'}. Open the Tropical System Watch tab for the latest official position, intensity and forecast.`};
  } else if(systems.length){
    const strongest=systems.reduce((a,b)=>b.score>a.score?b:a);
    if(strongest.level==='orange')overall={level:'orange',title:'Formation Watch — Multi-model signal',window:strongest.window,support:strongest.models,message:`<b>${strongest.basin}</b>: ${strongest.signal} indicated by ${strongest.models}. This is model guidance, not an official warning.`};
    else overall={level:'yellow',title:'Early Cyclogenesis Signal',window:strongest.window,support:strongest.models,message:`<b>${strongest.basin}</b>: models show a developing low-pressure environment. Continue monitoring subsequent runs and official guidance.`};
  } else if(official?.likely){overall={level:'orange',title:'Official Cyclogenesis Guidance',window:'Next 5–7 days',support:'Official guidance',message:'Official tropical guidance indicates a potential area for development. NWP screening is being monitored for independent confirmation.'};}
  const failures=modelRuns.filter(x=>x.error).map(x=>x.model.name+' / '+x.basin+': '+x.error);
  const statusMessage=failures.length?`Tropical watch updated with ${failures.length} model feed warning(s). Primary source: ${official?.sourceTier||'IMD/RSMC'} — ${official?.summary||'Unavailable'}.`:`Tropical watch updated. Primary source: ${official?.sourceTier||'IMD/RSMC'} — ${official?.summary||'Unavailable'}.`;
  const currentSystem=official?.hasCyclo?{name:official.name||'Unnamed system',basin:official.basin||'North Indian Ocean',status:official.category||'Tropical system',position:(finite(official.lat)&&finite(official.lon))?`${Math.abs(Number(official.lat)).toFixed(1)}°${Number(official.lat)>=0?'N':'S'} / ${Math.abs(Number(official.lon)).toFixed(1)}°${Number(official.lon)>=0?'E':'W'}`:'—',lat:official.lat,lon:official.lon,movement:official.movement||'—',wind:official.maxWindKmh?(official.maxWindKmh+' km/h'+(official.gustKmh?' gusting '+official.gustKmh+' km/h':'')):'—',pressure:finite(official.pressure)?official.pressure+' hPa':'—',forecast:official.forecastText||'See latest official bulletin',impact:official.impactText||'See latest official bulletin',warning:official.warningText||'—',issueTime:official.issueTime||'—',dateText:official.dateText||'—',bulletinTitle:official.bulletinTitle||'Official tropical-system bulletin',confidence:'High'}:null;
  return {statusCode:200,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, no-cache, must-revalidate, max-age=0','Pragma':'no-cache'},body:JSON.stringify({ok:true,updatedAt:new Date().toISOString(),overall,official,currentSystem,systems,modelResults:modelRuns.map(x=>({model:x.model.name,basin:x.basin,candidate:x.candidate,guidance:x.guidance||null,error:x.error||null})),statusMessage,failures,sourcePolicy:{primary:'IMD/RSMC live cyclone and hourly-bulletin layer',secondary:'IMD coastal/RSMC bulletins',backup:'WMO operational bulletin; NWP GFS/ECMWF/ICON for independent guidance',officialOverridesModels:true}})};
};
