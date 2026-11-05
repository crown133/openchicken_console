// Calibration targets only; PWM servos do not provide measured joint angles.
export function limits(value) {
  if(!value || !Number.isInteger(value.min) || !Number.isInteger(value.max) || value.min<1000 || value.max>2000 || value.min>=value.max)throw new Error('范围须为 1000–2000µs 内的整数，最小值小于最大值');
  return {min:value.min,max:value.max};
}
export class MouthPwm {
  constructor(element,{context,send}) {
    this.element=element;this.context=context;this.send=send;this.active=false;this.busy=false;this.epoch=0;this.robot=null;this.channel='J15';this.pulse=1500;this.lastTick=performance.now();
    element.innerHTML=`<div class="panel-head"><h3>Mouth · PWM 标定</h3><span>无位置反馈</span></div><div class="pwm-controls"><label>接口 <select data-channel><option>J15</option><option>J16</option></select></label><label>目标脉宽 <output data-value>1500 µs</output></label><input data-slider type="range" min="1400" max="1600" step="5" value="1500" aria-label="Mouth PWM 目标脉宽"><button data-enable>开启输出</button><button data-stop disabled>停止输出</button></div><p data-status role="status">输出未开启 · 角度未标定</p><div class="pwm-controls"><span data-lt-range>LT · J15 · 松开 1400 → 按到底 1050 µs</span><label><input data-reverse type="checkbox"> LT 反向（脉宽递减）</label><button data-lt-save>应用 LT 方向</button></div><details><summary>本机标定范围</summary><p>50Hz；J15 已标定为 1050–1400µs，J16 默认 1400–1600µs。接近机械端点时小步调整，勿顶住限位。数值为命令，不是实测角度。</p><label>最小 µs <input data-min type="number" min="1000" max="1999" value="1400"></label> <label>最大 µs <input data-max type="number" min="1001" max="2000" value="1600"></label> <button data-save>保存本机范围</button><p>J15 / J16 分别保存；仅在停止输出时修改。切换接口后需重新开启。</p></details><p data-message role="status"></p>`;
    this.q=selector=>element.querySelector(selector);
    this.q('[data-slider]').oninput=e=>{this.pulse=Number(e.target.value);this.q('[data-value]').textContent=`${this.pulse} µs`;};
    this.q('[data-enable]').onclick=()=>void this.enable();
    this.q('[data-lt-save]').onclick=()=>void this.saveDirection();
    this.q('[data-stop]').onclick=()=>void this.stop();
    this.q('[data-channel]').onchange=async e=>{const next=e.target.value;await this.stop();this.channel=next;this.load();};
    this.q('[data-save]').onclick=()=>{try{if(this.active||this.busy)throw new Error('请先停止输出');const range=limits({min:Number(this.q('[data-min]').value),max:Number(this.q('[data-max]').value)});localStorage.setItem(this.key(),JSON.stringify(range));this.load();this.message('范围已保存到本机浏览器');}catch(e){this.message(e.message);}};
    window.addEventListener('blur',()=>void this.stop());
    document.addEventListener('visibilitychange',()=>{if(document.hidden)void this.stop();});
    this.timer=setInterval(()=>void this.tick(),100);
  }
  key(){return `openchicken:pwm-calibration:v1:${this.robot}:${this.channel}`;}
  message(text){this.q('[data-message]').textContent=text;}
  load(){
    const cfg=this.context().state?.config;
    let range=this.channel==='J15'?{min:1050,max:1400}:{min:1400,max:1600};
    if(cfg?.interface===this.channel)range={min:cfg.min_us,max:cfg.max_us};
    try{const saved=localStorage.getItem(this.key());if(saved){const prior=limits(JSON.parse(saved));if(this.channel!=='J15'||prior.min>=range.min&&prior.max<=range.max)range=prior;}}catch{this.message('本地范围无效，使用默认范围');}
    this.pulse=this.channel==='J15'?range.max:Math.max(range.min,Math.min(range.max,1500));
    this.q('[data-min]').value=range.min;this.q('[data-max]').value=range.max;
    Object.assign(this.q('[data-slider]'),{min:range.min,max:range.max,value:this.pulse});this.q('[data-value]').textContent=`${this.pulse} µs`;
  }
  render(){
    const c=this.context();
    if(c.id!==this.robot){void this.stop();this.robot=c.id;this.channel='J15';this.q('[data-channel]').value='J15';this.load();}
    if(this.active&&!c.allowed)void this.stop();
    const s=c.state,config=s?.config;
    const signature=JSON.stringify([c.id,config]);
    if(signature!==this.configSignature){this.configSignature=signature;this.q('[data-reverse]').checked=!!config?.reverse;}
    this.q('[data-lt-range]').textContent=config?`LT · ${config.interface} · 松开 ${config.reverse?config.max_us:config.min_us} → 按到底 ${config.reverse?config.min_us:config.max_us} µs`:'LT 配置等待新版 PWM 服务';
    for(const name of ['reverse','lt-save'])this.q(`[data-${name}]`).disabled=!c.allowed||s?.version<2||!config||this.active||this.busy||!!s?.enabled;
    this.q('[data-status]').textContent=!c.online?'状态过期 / 未连接，输出状态未知':!s?.available?'PWM 标定服务未安装或未连接':s.error?s.error:`${s.interface||this.channel} · ${s.enabled?'输出开启':'输出关闭'}${s.owner?' / '+s.owner:''} · 已提交 ${s.pulse_us??'—'} µs · 无实测角度`;
    this.q('[data-enable]').disabled=!c.allowed||this.active||this.busy||!!s?.enabled;
    this.q('[data-stop]').disabled=!this.active&&!this.busy&&!s?.enabled;
    this.q('[data-channel]').disabled=this.busy;
    this.q('[data-slider]').disabled=!c.allowed||this.busy&&!this.active;
    for(const name of ['min','max','save'])this.q(`[data-${name}]`).disabled=!this.robot||this.active||this.busy||!!s?.enabled;
  }
  async saveDirection(){
    const c=this.context(),config=c.state?.config;
    if(!c.allowed||!config||this.busy||this.active||c.state?.enabled)return;
    this.busy=true;const reverse=this.q('[data-reverse]').checked;this.render();
    try{await this.send(c.id,{action:'configure',config:{...config,reverse}});this.message('LT 方向已保存到机器人与本机配置文件；松开 LT 后再按下生效');}
    catch(e){this.message(e.message);}finally{this.busy=false;this.render();}
  }
  async enable(){
    const c=this.context();if(!c.allowed||this.active||this.busy)return;
    const epoch=++this.epoch;this.session=crypto.randomUUID().replaceAll('-','');this.busy=true;this.render();
    try{await this.send(c.id,{action:'enable',interface:this.channel,pulse_us:this.pulse,session:this.session});if(epoch===this.epoch){this.active=true;this.lastTick=performance.now();this.message('输出已开启；失联超过 0.6 秒自动关闭');}}
    catch(e){this.message(e.message);}finally{this.busy=false;this.render();}
  }
  async stop(){
    const id=this.robot,needed=this.active||this.busy||this.context().state?.enabled;
    this.active=false;++this.epoch;
    if(needed&&id){try{await this.send(id,{action:'disable'});}catch(e){this.message(`停止回读未确认，板端租约将自动到期：${e.message}`);}}
  }
  async tick(){
    const now=performance.now(),gap=now-this.lastTick;this.lastTick=now;
    if(!this.active)return;
    if(gap>300||!this.context().allowed||document.hidden||!document.hasFocus()){await this.stop();return;}
    if(this.busy)return;
    this.busy=true;
    try{await this.send(this.robot,{action:'update',interface:this.channel,pulse_us:this.pulse,session:this.session});}
    catch(e){this.message(e.message);this.active=false;++this.epoch;}
    finally{this.busy=false;this.render();}
  }
}
