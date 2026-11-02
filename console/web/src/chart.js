import { tr } from './i18n.js?v=20261101-commissioning';
import { angleValue } from './angles.js';
import uPlot from '/vendor/uplot/dist/uPlot.esm.js';

function tickValues(values, suffix='') {
  const step = Math.abs(values[1]-values[0]);
  const digits = Number.isFinite(step) && step>0 ? Math.min(7, Math.max(0, 1-Math.floor(Math.log10(step)))) : 3;
  return values.map(value => `${Number(value.toFixed(digits))}${suffix}`);
}

export class JointChart {
  constructor(element) {
    this.element = element;
    this.unit = 'degree';
    this.paused = false;
    this.updateTheme();
    const panel = element.closest('.chart-panel');
    const tooltip = panel?.querySelector('#chart-tooltip') ?? document.getElementById('chart-tooltip');
    this.tooltip=tooltip;
    this.pauseButton = panel?.querySelector('#chart-pause');
    this.status = panel?.querySelector('#chart-status');
    this.plot = new uPlot({width: element.clientWidth, height: element.clientHeight || 300, padding: [20, 18, 5, 5],
      scales: {x: {time: false}}, legend: {show: false},
      axes: [
        {stroke: () => this.colors.muted, grid: {stroke: () => this.colors['chart-grid']}, ticks: {stroke: () => this.colors['chart-tick']}, size: 38, values: (_, v) => tickValues(v,'s')},
        {label: () => tr(this.unit==='rad'?'角度 (rad)':'角度 (°)'), labelSize: 22, size: 65,
          values: (_, v) => tickValues(v), stroke: () => this.colors.muted, grid: {stroke: () => this.colors['chart-grid']}, ticks: {stroke: () => this.colors['chart-tick']}}],
      cursor: {drag: {x: false, y: false}, bind: {dblclick: () => null}},
      series: [{}, ...[['请求','chart-requested'],['已提交','chart-submitted'],['反馈','chart-feedback']].map(([label,stroke],i) =>
        ({label:tr(label),stroke:()=>this.colors[stroke],width: i===2?2:1.3,dash:i===1?[5,4]:[],spanGaps:false,points:{show:false}}))],
      hooks: {setCursor: [plot => {
        if (!tooltip) return;
        const index = plot.cursor.idx;
        if (index == null || plot.cursor.left < 0 || this.drag) {tooltip.hidden = true; return;}
        tooltip.hidden = false;
        tooltip.style.left = `${Math.min(plot.cursor.left + 90, Math.max(5, element.clientWidth - 180))}px`;
        tooltip.style.top = `${element.offsetTop + 20}px`;
        tooltip.textContent = plot.series.slice(1).map((s,i) => `${s.label}  ${plot.data[i+1][index]?.toFixed(this.unit==='rad'?5:3) ?? '—'}${this.unit==='rad'?' rad':'°'}`).join('\n');
      }]}
    }, [[],[],[],[]], element);
    this.resize = new ResizeObserver(() => this.plot.setSize({width:element.clientWidth,height:element.clientHeight || 300}));
    this.resize.observe(element);
    if (this.pauseButton) this.pauseButton.onclick = () => this.paused ? this.resume() : this.pause();
    for (const [id, action] of [['chart-zoom-in',()=>this.zoom(.75)],['chart-zoom-out',()=>this.zoom(1/.75)],['chart-reset',()=>this.resume()]]) {
      const button = panel?.querySelector(`#${id}`);
      if (button) button.onclick = action;
    }
    const over = this.plot.over;
    over.addEventListener('wheel', event => {
      event.preventDefault();
      const rect = over.getBoundingClientRect();
      this.zoom(Math.exp(Math.sign(event.deltaY)*.18), (event.clientX-rect.left)/rect.width, 1-(event.clientY-rect.top)/rect.height);
    }, {passive:false});
    over.addEventListener('pointerdown', event => {
      if (event.button!==0 || this.drag || !this.pause()) return;
      this.drag = {id:event.pointerId, x:event.clientX, y:event.clientY, scales:this.bounds()};
      over.setPointerCapture(event.pointerId);
      over.classList.add('panning');
      if (tooltip) tooltip.hidden=true;
    });
    over.addEventListener('pointermove', event => {
      if (!this.drag || event.pointerId!==this.drag.id) return;
      const {x,y,scales} = this.drag;
      const dx = (event.clientX-x)/over.clientWidth*(scales.x.max-scales.x.min);
      const dy = (event.clientY-y)/over.clientHeight*(scales.y.max-scales.y.min);
      this.setBounds({x:{min:scales.x.min-dx,max:scales.x.max-dx},y:{min:scales.y.min+dy,max:scales.y.max+dy}});
    });
    const endDrag = event => {
      if (this.drag?.id!==event.pointerId) return;
      this.drag=null;
      over.classList.remove('panning');
      if (over.hasPointerCapture(event.pointerId)) over.releasePointerCapture(event.pointerId);
    };
    for (const name of ['pointerup','pointercancel','lostpointercapture']) over.addEventListener(name,endDrag);
    over.addEventListener('dblclick',()=>this.resume());
    this.showState();
  }
  updateTheme() {
    const style=getComputedStyle(document.documentElement);
    this.colors=Object.fromEntries(['muted','chart-grid','chart-tick','chart-requested','chart-submitted','chart-feedback'].map(name=>[name,style.getPropertyValue(`--${name}`).trim()]));
    this.plot?.redraw(true,true);
  }
  showState() {
    this.element.dataset.paused=String(this.paused);
    if (this.pauseButton) {
      this.pauseButton.textContent=tr(this.paused?'恢复跟随':'暂停曲线');
      this.pauseButton.setAttribute('aria-pressed',String(this.paused));
    }
    if (this.status) this.status.textContent=tr(this.paused?'曲线已暂停 · 采集继续':'跟随所选数据');
  }
  pause() {
    if (!this.plot.data[0].length) return false;
    this.paused=true;
    this.showState();
    return true;
  }
  resume() {
    this.paused=false;
    this.drag=null;
    this.plot.over.classList.remove('panning');
    this.showState();
    if (this.latest) this.draw(this.latest);
  }
  bounds() {
    return Object.fromEntries(['x','y'].map(key=>[key,{min:this.plot.scales[key].min,max:this.plot.scales[key].max}]));
  }
  setBounds(bounds) {
    // Keep horizontal navigation inside the buffered history (or the empty time window).
    const low=Math.min(this.plot.data[0][0]??0,-this.latest.seconds), high=0;
    const width=Math.min(bounds.x.max-bounds.x.min,high-low);
    bounds.x.min=Math.max(low,Math.min(high-width,bounds.x.min));
    bounds.x.max=bounds.x.min+width;
    this.plot.batch(()=>{for (const key of ['x','y']) this.plot.setScale(key,bounds[key]);});
  }
  zoom(factor, x=.5, y=.5) {
    if (!this.pause()) return;
    const bounds=this.bounds();
    for (const [key,anchor] of [['x',x],['y',y]]) {
      const scale=bounds[key], span=scale.max-scale.min;
      if (!Number.isFinite(span) || span<=0) return;
      const width=Math.max(key==='x'?.02:1e-6,Math.min(1e6,span*factor));
      const center=scale.min+span*anchor;
      bounds[key]={min:center-width*anchor,max:center+width*(1-anchor)};
    }
    this.setBounds(bounds);
  }
  update(samples, jointId, seconds, endTime, unit='degree', context='') {
    const last=samples.at(-1)?.state;
    const key=JSON.stringify([context,last?.robot_id,last?.boot_id,jointId,seconds]);
    const changed=this.key!==key;
    this.key=key;
    this.latest={samples,jointId,seconds,end:endTime??samples.at(-1)?.time};
    if (this.unit!==unit) {
      if (this.tooltip) this.tooltip.hidden=true;
      const factor=unit==='rad'?Math.PI/180:180/Math.PI;
      this.unit=unit;
      if (this.paused && !changed) {
        const bounds=this.bounds();
        bounds.y.min*=factor;bounds.y.max*=factor;
        this.plot.setData(this.plot.data.map((series,i)=>i?series.map(v=>v==null?null:v*factor):series),false);
        this.setBounds(bounds);
      }
    }
    this.element.dataset.unit=unit;
    if (changed) this.resume();
    else if (!this.paused) this.draw(this.latest);
  }
  draw({samples,jointId,seconds,end}) {
    const data=[[],[],[],[]];
    // Match the live history limit; large replay files must not grow each draw unbounded.
    let low=0, high=samples.length;
    while (low<high) {
      const mid=(low+high)>>>1;
      if (samples[mid].time<=end) low=mid+1; else high=mid;
    }
    if (end!=null) for (let i=Math.max(0,low-1300);i<low;i++) {
      const sample=samples[i];
      const joint=sample.state.joints.find(j=>j.id===jointId);
      data[0].push(sample.time-end);
      const valid=joint?.valid && sample.state.online!==false;
      data[1].push(valid?angleValue(joint.requested,this.unit):null);
      data[2].push(valid?angleValue(joint.submitted,this.unit):null);
      data[3].push(valid?angleValue(joint.position,this.unit):null);
    }
    this.plot.batch(()=>{
      this.plot.setData(data);
      this.plot.setScale('x',{min:-seconds,max:0});
    });
  }
  destroy() {
    this.resize.disconnect();
    this.plot.destroy();
  }
}
