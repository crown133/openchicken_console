import { tr } from './i18n.js?v=20261101-commissioning';

const names=['A','B','X','Y','LB','RB','LT','RT','View','Start','LS','RS','↑','↓','←','→','Xbox'];
const setText=(element,value)=>{if(element.textContent!==value)element.textContent=value;};
const axis=value=>Number.isFinite(value)?Math.max(-1,Math.min(1,value)):0;
const buttonValue=button=>Number.isFinite(button?.value)?Math.max(0,Math.min(1,button.value)):button?.pressed?1:0;
const face=(index,x,y,color)=>`<g class="pad-button pad-face" data-pad-button="${index}" style="--pad-button-color:${color}" transform="translate(${x} ${y})"><circle r="21"/><text y="7">${names[index]}</text></g>`;
const stick=(index,x,y,label)=>`<g transform="translate(${x} ${y})"><circle class="pad-stick-well" r="49"/><circle class="pad-stick-rim" r="43"/><g data-pad-stick="${index}" class="pad-button pad-stick" data-pad-button="${index+10}"><circle r="29"/><circle class="pad-knob-ring" r="22"/><text y="5">${label}</text></g></g>`;
const axisCard=(index,label,mapping)=>`<div class="pad-axis-card"><div class="pad-reading-title"><strong>${label}</strong><span>${mapping}</span></div><div class="pad-axis-body"><svg viewBox="0 0 100 100" aria-hidden="true"><circle class="pad-axis-range" cx="50" cy="50" r="38"/><path class="pad-crosshair" d="M8 50H92M50 8V92"/><circle class="pad-axis-deadzone" cx="50" cy="50" r="4.56"/><line data-pad-axis-line="${index}" x1="50" y1="50" x2="50" y2="50"/><circle class="pad-axis-point" data-pad-axis-dot="${index}" cx="50" cy="50" r="4"/></svg><div class="pad-axis-numbers"><span>X <output data-pad-axis="${index*2}">—</output></span><span>Y <output data-pad-axis="${index*2+1}">—</output></span></div></div></div>`;

// Read-only view: takes a browser Gamepad snapshot; it never sends or changes control input.
export class GamepadView {
  constructor(element) {
    this.element=element;
    this.lastPaint=-Infinity;
    element.innerHTML=`<div class="pad-view-heading"><div><strong>XBOX</strong><span>${tr('手柄输入')}</span></div><span class="badge" data-pad-connection>${tr('未连接')}</span><span class="pad-device" data-pad-device></span></div>
      <div class="pad-view-grid"><div class="pad-figure"><svg viewBox="0 0 640 355" role="img" aria-label="${tr('Xbox 手柄实时按键和摇杆状态')}">
      <g class="pad-button pad-trigger" data-pad-button="6"><path d="M136 93L143 72Q145 62 157 62H187Q199 62 201 73L205 93Z"/><rect class="pad-trigger-fill" data-pad-trigger="0" x="145" y="81" width="0" height="5" rx="2"/><text x="171" y="77">LT</text></g>
      <g class="pad-button pad-trigger" data-pad-button="7"><path d="M504 93L497 72Q495 62 483 62H453Q441 62 439 73L435 93Z"/><rect class="pad-trigger-fill" data-pad-trigger="1" x="444" y="81" width="0" height="5" rx="2"/><text x="469" y="77">RT</text></g>
      <path class="pad-shell" d="M151 82C120 87 101 110 88 148C73 190 61 244 62 285C63 313 76 330 100 329C130 328 156 309 184 284C203 267 217 258 244 258C274 258 289 265 320 265C351 265 366 258 396 258C423 258 437 267 456 284C484 309 510 328 540 329C564 330 577 313 578 285C579 244 567 190 552 148C539 110 520 87 489 82C455 77 434 88 410 99C381 112 353 113 320 113C287 113 259 112 230 99C206 88 185 77 151 82Z"/>
      <path class="pad-faceplate" d="M91 147C116 116 148 107 180 109C216 111 242 133 277 139C304 144 336 144 363 139C398 133 424 111 460 109C492 107 524 116 549 147C536 114 517 96 488 92C455 87 435 98 411 109C381 122 352 123 320 123C288 123 259 122 229 109C205 98 185 87 152 92C123 96 104 114 91 147Z"/>
      <path class="pad-seam" d="M80 209C84 257 112 290 142 307M560 209C556 257 528 290 498 307"/>
      <g class="pad-button pad-shoulder" data-pad-button="4"><path d="M119 95Q154 70 204 85L220 105Q170 89 112 115Z"/><text x="168" y="99">LB</text></g>
      <g class="pad-button pad-shoulder" data-pad-button="5"><path d="M521 95Q486 70 436 85L420 105Q470 89 528 115Z"/><text x="472" y="99">RB</text></g>
      <g class="pad-button pad-home" data-pad-button="16"><circle cx="320" cy="166" r="20"/><path d="M309 155Q320 160 331 177M331 155Q320 160 309 177"/></g>
      <g class="pad-button pad-system" data-pad-button="8"><rect x="260" y="147" width="29" height="23" rx="8"/><path d="M267 154h11v9h-11zM272 150h10v9"/><text x="274" y="187">VIEW</text></g>
      <g class="pad-button pad-system" data-pad-button="9"><rect x="351" y="147" width="29" height="23" rx="8"/><path d="M359 154h13m-13 4h13m-13 4h13"/><text x="366" y="187">START</text></g>
      ${stick(0,176,158,'LS')}${stick(1,407,235,'RS')}
      <g transform="translate(248 239)"><circle class="pad-stick-well" r="43"/><path class="pad-dpad-base" d="M-13-33H13V-13H33V13H13V33H-13V13H-33V-13H-13Z"/>
      <g class="pad-button pad-direction" data-pad-button="12"><path d="M-12-32H12V-13L0-4-12-13Z"/></g><g class="pad-button pad-direction" data-pad-button="13"><path d="M-12 32H12V13L0 4-12 13Z"/></g><g class="pad-button pad-direction" data-pad-button="14"><path d="M-32-12V12H-13L-4 0-13-12Z"/></g><g class="pad-button pad-direction" data-pad-button="15"><path d="M32-12V12H13L4 0 13-12Z"/></g></g>
      ${face(3,477,127,'#b28a19')}${face(2,439,164,'#3978ce')}${face(1,515,164,'#d94f4b')}${face(0,477,201,'#2d9c65')}
      </svg><div class="pad-pressed"><span>${tr('按下')}</span><output data-pad-pressed>—</output></div></div>
      <div class="pad-readings"><div class="pad-axes">${axisCard(0,'LS','vx / vy')}${axisCard(1,'RS','yaw')}</div>
      <div class="pad-triggers">${[0,1].map(i=>`<div><div class="pad-reading-title"><strong>${i?'RT':'LT'}</strong><output data-pad-trigger-value="${i}">—</output></div><div class="pad-trigger-track"><span data-pad-trigger-meter="${i}"></span></div></div>`).join('')}</div>
      <div class="pad-shortcuts">${[['9','Start','初始化'],['4,1','LB + B','急停'],['4,0','LB + A','坐下 / 站起'],['4,2','LB + X','左脚踢球'],['4,3','LB + Y','右脚踢球']].map(([chord,key,label])=>`<div data-pad-chord="${chord}"><kbd>${key}</kbd><span>${tr(label)}</span></div>`).join('')}</div>
      <p class="pad-raw-note">${tr('原始输入 · 中心死区 12% · 视图本身不发送指令')}</p></div></div>`;
    this.buttons=[...element.querySelectorAll('[data-pad-button]')];
    this.sticks=[...element.querySelectorAll('[data-pad-stick]')];
    this.axes=[...element.querySelectorAll('[data-pad-axis]')];
    this.dots=[...element.querySelectorAll('[data-pad-axis-dot]')];
    this.lines=[...element.querySelectorAll('[data-pad-axis-line]')];
    this.triggers=[...element.querySelectorAll('[data-pad-trigger]')];
    this.meters=[...element.querySelectorAll('[data-pad-trigger-meter]')];
    this.triggerValues=[...element.querySelectorAll('[data-pad-trigger-value]')];
    this.chords=[...element.querySelectorAll('[data-pad-chord]')];
    this.connection=element.querySelector('[data-pad-connection]');
    this.device=element.querySelector('[data-pad-device]');
    this.pressed=element.querySelector('[data-pad-pressed]');
    this.update(null,0,true);
  }
  update(pad,now,visible=true) {
    const connected=!!pad?.connected;
    const supported=connected && pad.mapping==='standard' && pad.axes.length>=4 && pad.buttons.length>=10 && pad.axes.slice(0,4).every(Number.isFinite);
    const state=!visible?'paused':!connected?'disconnected':!supported?'unsupported':'connected';
    if(now-this.lastPaint<32 && this.element.dataset.state===state)return;
    this.lastPaint=now;
    this.element.dataset.state=state;
    const live=state==='connected';
    setText(this.connection,tr({paused:'手柄视图已暂停',disconnected:'未连接',unsupported:'手柄布局不受支持',connected:'手柄已连接'}[state]));
    this.connection.classList.toggle('green',live);
    setText(this.device,connected?pad.id:tr('手柄接入监控主机后，按任意键以识别'));
    this.device.title=connected?pad.id:'';
    const values=Array.from({length:4},(_,i)=>live?axis(pad.axes[i]):0);
    const signature=JSON.stringify([state,values,live?pad.buttons.map(b=>[b.pressed,buttonValue(b)]):[]]);
    if(this.signature===signature)return;
    this.signature=signature;
    this.buttons.forEach(node=>{
      const index=Number(node.dataset.padButton),button=live?pad.buttons[index]:null;
      node.classList.toggle('is-pressed',!!button?.pressed);
      node.classList.toggle('is-unavailable',live&&!button);
    });
    this.sticks.forEach((node,i)=>node.setAttribute('transform',`translate(${values[i*2]*17} ${values[i*2+1]*17})`));
    this.axes.forEach((node,i)=>setText(node,live?values[i].toFixed(3):'—'));
    this.dots.forEach((node,i)=>{
      const x=50+values[i*2]*38,y=50+values[i*2+1]*38;
      node.setAttribute('cx',x);node.setAttribute('cy',y);
      this.lines[i].setAttribute('x2',x);this.lines[i].setAttribute('y2',y);
    });
    this.triggers.forEach((node,i)=>{
      const button=live?pad.buttons[6+i]:null,value=buttonValue(button);
      node.setAttribute('width',value*51);
      this.meters[i].style.width=`${value*100}%`;
      setText(this.triggerValues[i],button?`${Math.round(value*100)}%`:'—');
    });
    this.chords.forEach(node=>node.classList.toggle('is-pressed',live&&node.dataset.padChord.split(',').every(index=>pad.buttons[Number(index)]?.pressed)));
    setText(this.pressed,live?names.filter((_,i)=>pad.buttons[i]?.pressed).join(' + ')||tr('未按下'):'—');
  }
}
