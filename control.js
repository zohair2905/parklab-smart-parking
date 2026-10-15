// Presentation only: never write into a recorded car or simulation setting.
const $=id=>document.getElementById(id);
const dataset=new URLSearchParams(location.search).get('dataset')==='legacy'?'legacy':'part_a';
$('dataset').value=dataset;
$('dataset').onchange=()=>{location.href=`?dataset=${$('dataset').value}`;};
let log,minute=150,currentMode='Smart';
function redrawRegister(){
  if(!log)return;
  const floor=Number($('registerFloor').value),name=currentMode==='Normal'?'Normal':'Smart';
  const spots=log.layout.filter(s=>(s.level??1)===floor);
  const claimed=new Map(log.modes[name].cars.filter(c=>c.spot_index!=null&&c.assign_time<=minute&&minute<c.leave_time).map(c=>[c.spot_index,c]));
  const free=spots.filter(s=>!claimed.has(s.index)).length;
  $('freeCount').textContent=String(free).padStart(2,'0');
  $('registerMode').textContent=`${name.toUpperCase()} / ${floor===1?'GROUND':'UPPER'}`;
  const grid=$('bayGrid'),key=`${name}-${floor}`;
  if(grid.dataset.key!==key){grid.dataset.key=key;grid.replaceChildren(...spots.map(s=>{
    const b=document.createElement('button'),car=claimed.get(s.index);
    b.className=car?'busy':'';b.textContent=String(s.index).padStart(2,'0');
    b.setAttribute('aria-label',`Bay ${s.index}, ${s.kind}, ${car?'claimed by car '+car.car_id:'free'}`);
    b.title=b.getAttribute('aria-label');
    if(s.kind!=='Normal'){const sup=document.createElement('sup');sup.textContent=s.kind==='EV'?'E':'R';b.append(sup);}
    b.onclick=()=>document.dispatchEvent(new CustomEvent('parking-select-bay',{detail:{mode:name,index:s.index}}));
    return b;
  }));}
  [...grid.children].forEach((button,i)=>{
    const spot=spots[i],car=claimed.get(spot.index);
    button.classList.toggle('busy',!!car);
    const label=`Bay ${spot.index}, ${spot.kind}, ${car?'claimed by car '+car.car_id:'free'}`;
    button.setAttribute('aria-label',label);button.title=label;
  });
}
document.addEventListener('parking-frame',e=>{minute=e.detail.minute;currentMode=e.detail.mode;redrawRegister();});
$('registerFloor').onchange=redrawRegister;
document.querySelectorAll('[data-time]').forEach(b=>{b.onclick=()=>{$('timeline').value=b.dataset.time;$('timeline').dispatchEvent(new Event('input',{bubbles:true}));};});
$('exportLog').onclick=()=>{
  const blob=new Blob([JSON.stringify(log,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=`parklab-${dataset}-recorded-log.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
async function comparison(){
  const response=await fetch(dataset==='legacy'?'comparison.csv':'part_a/comparison.csv');
  if(!response.ok)throw new Error('The experiment comparison could not be loaded.');
  const [headers,...rows]=(await response.text()).trim().split(/\r?\n/).map(r=>r.split(','));
  const records=Object.fromEntries(rows.map(r=>[r[0],Object.fromEntries(headers.slice(1).map((h,i)=>[h,Number(r[i+1])]))]));
  const fields=[['Average search','Avg search (min)',' min'],['Average occupancy','Avg occupancy (%)','%'],['Parked visits','Parked',''],['Turned away','Turned away',''],['Price refusals','balked_price',''],['Total revenue','Revenue (CU)',' CU']].filter(([,k])=>Number.isFinite(records.Normal[k]));
  $('comparisonRows').replaceChildren(...fields.map(([name,key,unit])=>{
    const row=document.createElement('tr');
    [name,...['Normal','Smart'].map(mode=>records[mode][key].toFixed(2)+unit)].forEach(t=>{const cell=document.createElement('td');cell.textContent=t;row.append(cell);});return row;
  }));
  const reduction=100*(1-records.Smart['Avg search (min)']/records.Normal['Avg search (min)']);
  $('finding').textContent=`${reduction.toFixed(1)}% less searching for admitted cars in Smart mode.`;
  $('comparisonNote').textContent=dataset==='legacy'?'Original model, seeds 42–51. These are simulated results, not measurements from a physical parking lot.':'Smart mode also averaged 104.60 price refusals per run. Fewer space-related turnaways does not mean more drivers parked. Counts are ten-run averages.';
}
try{
  const response=await fetch(dataset==='legacy'?'simulation_log.json':'part_a/simulation_log.json');
  if(!response.ok)throw new Error('Recorded experiment data is missing.');
  log=await response.json();
  const levels=Math.max(...log.layout.map(s=>s.level??1));
  $('levelsCount').textContent=`${levels} ${levels===1?'LEVEL':'LEVELS'}`;
  document.querySelector('.intro p').textContent=levels===1?'Fifty spaces, one open lot. Watch how a parking decision changes the day.':'Fifty spaces, two levels. Watch how a parking decision changes the day.';
  if(levels===1){$('registerFloor').querySelector('option[value="2"]').remove();}
  $('carNumber').max=log.modes.Smart.cars.length;
  redrawRegister();await comparison();
  const {startReplay}=await import('./main.js?v=control-1');
  await startReplay(log);
}catch(error){$('error').hidden=false;$('error').textContent=`${error.message} Run the included local server and check your internet connection for the 3D library.`;$('status').textContent='Replay unavailable';}
