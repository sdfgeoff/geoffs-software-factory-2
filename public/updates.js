const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export class Updates {
  constructor({api,mutate,user,open,context,changed}) {
    Object.assign(this,{api,mutate,user,open,context,changed});this.filter='all';this.ready=false;this.groups=[];this.latest=0;this.lastChime=0;
    this.key=`commonroom:updates:${user.id}`;
    this.prefs=this.readPrefs();
    this.storage=e=>{if(e.key===this.key){this.prefs=this.readPrefs();this.controls();}};
    window.addEventListener('storage',this.storage);
  }
  readPrefs(){try{return {enabled:false,volume:.25,mode:'all',paused:0,tab:true,...JSON.parse(localStorage.getItem(this.key)||'{}')};}catch{return {enabled:false,volume:.25,mode:'all',paused:0,tab:true};}}
  save(){try{localStorage.setItem(this.key,JSON.stringify(this.prefs));}catch{}this.controls();}
  async chime(){
    try{this.audio ||= new (window.AudioContext||window.webkitAudioContext)();await this.audio.resume();if(this.audio.state!=='running')throw Error();
      const oscillator=this.audio.createOscillator(),gain=this.audio.createGain(),time=this.audio.currentTime;
      oscillator.frequency.value=660;gain.gain.setValueAtTime(0,time);gain.gain.linearRampToValueAtTime(Math.max(0,Math.min(1,this.prefs.volume))*.15,time+.02);gain.gain.exponentialRampToValueAtTime(.001,time+.25);
      oscillator.connect(gain);gain.connect(this.audio.destination);oscillator.start(time);oscillator.stop(time+.3);
      this.audioStatus='';
    }catch{this.audioStatus='Audio blocked or unavailable. Click Test sound to retry.';}this.controls();
  }
  async sound(data){
    const previous=this.latest;this.latest=Math.max(this.latest,data.latest);
    if(!this.ready){this.ready=true;return;}
    if(!this.prefs.enabled||this.prefs.paused>Date.now()||data.latest<=previous)return;
    const ctx=this.context();
    const candidates=(data.arrivals||data.groups).filter(g=>g.id>previous&&g.unread&&(this.prefs.mode!=='mentions'||g.mentions));
    if(!candidates.some(g=>!(ctx.focused&&(g.ticket_id?ctx.ticket===g.ticket_id:g.parent_id?ctx.thread===g.parent_id:ctx.channel===g.channel_id))))return;
    // A shared high-water mark, protected by Web Locks, prevents cross-tab chimes.
    const play=async()=>{
      let last=0;try{last=Number(localStorage.getItem(this.key+':sounded'))||0;}catch{}
      if(last>=data.latest)return;
      try{localStorage.setItem(this.key+':sounded',String(data.latest));}catch{return;}
      if(Date.now()-this.lastChime<1500)return;this.lastChime=Date.now();await this.chime();
    };
    if(navigator.locks)await navigator.locks.request(this.key+':sound',play);
    else {
      // LAN HTTP may lack Web Locks; use a short shared-storage election.
      const token=crypto.randomUUID?.()||String(Math.random()),key=this.key+':lease';
      try{localStorage.setItem(key,token);await new Promise(resolve=>setTimeout(resolve,80));if(localStorage.getItem(key)===token)await play();}catch{await this.chime();}
    }
  }
  async refresh(){
    if(this.pending)return this.pending;
    this.pending=this.refreshNow().finally(()=>{this.pending=null;});return this.pending;
  }
  async refreshNow(){
    const data=await this.api('/notifications?view=overview&filter='+this.filter+'&after='+this.latest);
    for(let i=1;i<(this.loadedPages||1)&&data.next;i++){const page=await this.api('/notifications?view=overview&filter='+this.filter+'&before='+data.next);data.groups.push(...page.groups);data.next=page.next;}
    if(this.destroyed)return;
    await this.sound(data);this.data=data;this.groups=data.groups;
    const badge=document.querySelector('#notice-count');if(badge){badge.setAttribute('aria-live','polite');badge.parentElement.classList.toggle('sounds-paused',this.prefs.paused>Date.now());badge.parentElement.title=this.prefs.paused>Date.now()?'Notification sounds paused':'Workspace updates';badge.hidden=!data.unread;badge.textContent=data.unread>99?'99+':data.unread;badge.parentElement.setAttribute('aria-label',`Workspace updates, ${data.unread} unread`);}
    document.title=this.prefs.tab&&data.unread?`(${data.unread>99?'99+':data.unread}) Commonroom`:'Commonroom';
    this.changed(data);if(this.drawer){this.controls();this.renderGroups();}return data;
  }
  async show(){
    if(this.drawer){this.close();return;}
    this.returnFocus=document.activeElement;
    const root=document.createElement('section');root.className='updates-drawer';root.setAttribute('aria-label','Workspace updates');root.setAttribute('role','dialog');root.tabIndex=-1;this.drawer=root;this.preferencesOpen=false;
    root.innerHTML=`<header><h2>Updates</h2><button data-update="close" aria-label="Close updates">×</button></header><nav class="updates-tabs" aria-label="Updates views"><button data-update="activity" aria-pressed="true">Activity</button><button data-update="preferences" aria-pressed="false">Preferences</button></nav><div class="updates-tools"><label>Show <select id="updates-filter"><option value="all">All</option><option value="unread">Unread</option><option value="mentions">Mentions</option></select></label><button data-update="read-all">Mark all read</button></div><section class="updates-settings" hidden aria-labelledby="preferences-heading"><h3 id="preferences-heading">Notification preferences</h3><p class="settings-intro">Changes save automatically for your account in this browser.</p><fieldset class="settings-card"><legend>Sound</legend><label class="settings-switch" for="updates-sound"><span>Play notification sounds<small>A gentle chime for new activity, not existing unread updates.</small></span><input type="checkbox" role="switch" id="updates-sound"></label><div class="sound-status-row"><span id="sound-state" role="status"></span><button data-update="test" type="button">Preview sound</button></div><div class="settings-dependent"><label for="updates-mode">When to play a sound</label><select id="updates-mode" aria-describedby="sound-mode-hint"><option value="all">All new updates</option><option value="mentions">Only direct mentions</option></select><p class="settings-hint" id="sound-mode-hint">The conversation you’re actively viewing stays silent.</p><div class="volume-label"><label for="updates-volume">Volume</label><output id="volume-value" for="updates-volume"></output></div><input id="updates-volume" aria-describedby="volume-hint" type="range" min="0" max="1" step="0.05"><p id="volume-hint" class="settings-hint">Preview sound to check the level. Your device volume also applies.</p></div><p id="updates-audio-status" role="status"></p></fieldset><fieldset class="settings-card"><legend>Take a break</legend><p class="settings-hint" id="pause-hint">Pause sounds without hiding updates or marking anything read.</p><label for="updates-pause">Pause sounds for</label><select id="updates-pause" aria-describedby="pause-hint"><option value="0">Not paused</option><option value="30">30 minutes</option><option value="60">1 hour</option></select><button data-update="resume" type="button" hidden>Resume sounds now</button></fieldset><fieldset class="settings-card"><legend>Display</legend><label class="settings-switch" for="updates-tab"><span>Unread count in browser tab<small>Show the count only, never message contents.</small></span><input type="checkbox" role="switch" id="updates-tab"></label></fieldset><p class="settings-hint">Audio may need browser permission. These preferences sync across tabs in this browser, not other devices.</p></section><p id="updates-summary" role="status"></p><div id="updates-list"></div><button data-update="more-groups" hidden>Older conversations</button>`;
    document.body.append(root);root.addEventListener('click',e=>this.click(e).catch(error=>this.error(error)));
    root.addEventListener('input',e=>{if(e.target.id==='updates-volume')root.querySelector('#volume-value').textContent=Math.round(Number(e.target.value)*100)+'%';});
    root.addEventListener('change',e=>this.change(e).catch(error=>this.error(error)));
    root.addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();this.close();}if(e.key==='Tab'){e.stopPropagation();const all=[...root.querySelectorAll('button:not([hidden]),select,input,summary')].filter(el=>!el.disabled&&el.getClientRects().length);if(e.shiftKey&&document.activeElement===all[0]){e.preventDefault();all.at(-1)?.focus();}else if(!e.shiftKey&&document.activeElement===all.at(-1)){e.preventDefault();all[0]?.focus();}}});
    root.querySelector('#updates-filter').value=this.filter;this.controls();await this.refresh();if(root.isConnected)root.querySelector('[data-update=close]').focus();
  }
  controls(){if(!this.drawer)return;const q=s=>this.drawer.querySelector(s);
    q('#updates-sound').checked=this.prefs.enabled;q('#updates-volume').value=this.prefs.volume;q('#updates-mode').value=this.prefs.mode;q('#updates-tab').checked=this.prefs.tab;
    q('#sound-state').textContent=this.prefs.paused>Date.now()?'Paused until '+new Date(this.prefs.paused).toLocaleTimeString():this.prefs.enabled?'Sounds on':'Sounds off';
    q('#volume-value').textContent=Math.round(this.prefs.volume*100)+'%';
    q('#updates-volume').disabled=!this.prefs.enabled;q('#updates-mode').disabled=!this.prefs.enabled;
    q('.settings-dependent').classList.toggle('settings-muted',!this.prefs.enabled);
    q('[data-update=resume]').hidden=this.prefs.paused<=Date.now();
    q('#updates-pause').value=this.prefs.paused>Date.now()?(this.prefs.paused-Date.now()<=1800000?'30':'60'):'0';
    q('#updates-audio-status').textContent=this.audioStatus||'';
  }
  close(){this.drawer?.remove();this.drawer=null;if(this.returnFocus?.isConnected)this.returnFocus.focus();}
  destroy(){this.destroyed=true;this.close();window.removeEventListener('storage',this.storage);this.audio?.close();document.title='Commonroom';}
  error(error){if(this.drawer)this.drawer.querySelector('#updates-summary').textContent=error.message;}
  label(g){return g.ticket_id?`${g.ticket_key} · ${g.ticket_title}`:`#${this.context().channels.find(c=>c.id===g.channel_id)?.name||'channel'}${g.parent_id?' · Thread':''}`;}
  renderGroups(){
    const root=this.drawer.querySelector('#updates-list');
    // Preserve expanded event lists and focus while live totals update.
    const focused=document.activeElement,focusGroup=focused?.closest('[data-group]')?.dataset.group,focusAction=focused?.dataset.update;
    const fingerprint=JSON.stringify(this.groups);if(root.dataset.fingerprint!==fingerprint){root.dataset.fingerprint=fingerprint;
      root.innerHTML=this.groups.map(g=>`<article class="update-group ${g.unread?'unread':''}" data-group="${esc(g.group_key)}"><button class="update-open" data-update="open" data-id="${g.id}"><strong>${esc(this.label(g))}</strong><span>${g.unread?`${g.unread} unread · `:''}${g.mentions?'@ Mention · ':''}${g.total} updates</span><p>${esc(g.body.slice(0,200))}</p></button><div class="update-actions"><button data-update="toggle-read" data-read="${Boolean(g.unread)}">${g.unread?'Mark read':'Mark unread'}</button><button data-update="unfollow">Unfollow</button><button data-update="expand" aria-expanded="false">Events</button></div><div class="update-events" hidden></div></article>`).join('')||'<p>No updates here.</p>';
    }
    if(focusGroup&&focusAction&&!focused.isConnected){const article=[...root.querySelectorAll('[data-group]')].find(el=>el.dataset.group===focusGroup);(article?.querySelector(`[data-update="${focusAction}"]`)||this.drawer).focus();}
    this.drawer.querySelector('[data-update=read-all]').disabled=!this.data.unread;
    this.drawer.querySelector('#updates-summary').textContent=`${this.data.unread} unread notifications`;
    this.drawer.querySelector('[data-update=more-groups]').hidden=this.preferencesOpen||!this.data.next;
  }
  async change(e){const el=e.target;
    if(el.id==='updates-filter'){this.filter=el.value;this.loadedPages=1;await this.refresh();return;}
    if(el.id==='updates-sound'){this.prefs.enabled=el.checked;if(el.checked)await this.chime();}
    if(el.id==='updates-volume')this.prefs.volume=Number(el.value);
    if(el.id==='updates-mode')this.prefs.mode=el.value;
    if(el.id==='updates-tab')this.prefs.tab=el.checked;
    if(el.id==='updates-pause')this.prefs.paused=el.value==='0'?0:Date.now()+Number(el.value)*60000;
    this.save();document.title=this.prefs.tab&&this.data?.unread?`(${this.data.unread}) Commonroom`:'Commonroom';
  }
  async click(e){const button=e.target.closest('[data-update]');if(!button)return;
    const action=button.dataset.update,article=button.closest('[data-group]'),g=article&&this.groups.find(g=>g.group_key===article.dataset.group);
    if(action==='activity'||action==='preferences'){
      const preferences=action==='preferences';this.drawer.querySelector('.updates-settings').hidden=!preferences;
      for(const selector of ['.updates-tools','#updates-summary','#updates-list'])this.drawer.querySelector(selector).hidden=preferences;
      this.drawer.querySelector('[data-update=more-groups]').hidden=preferences||!this.data?.next;
      for(const name of ['activity','preferences'])this.drawer.querySelector(`[data-update="${name}"]`).setAttribute('aria-pressed',String(action===name));
      this.preferencesOpen=preferences;return;
    }
    if(action==='resume'){this.prefs.paused=0;this.save();return;}
    if(action==='close'){this.close();return;}
    if(action==='test'){await this.chime();return;}
    if(action==='read-all'){await this.mutate('/notifications/read',{through:this.data.latest},'PUT');await this.refresh();return;}
    if(action==='toggle-read'){await this.mutate('/notifications/read',{group:g.group_key,read:button.dataset.read==='true',through:g.id},'PUT');await this.refresh();return;}
    if(action==='unfollow'){
      if(!confirm('Unfollow this conversation? Direct mentions can still notify you. Channel subscriptions may still notify you about thread replies.'))return;
      if(g.ticket_id)await this.mutate(`/tickets/${g.ticket_id}/subscription`,{subscribed:false},'PUT');
      else if(g.parent_id)await this.mutate(`/messages/${g.parent_id}/subscription`,{subscribed:false},'PUT');
      else await this.mutate(`/channels/${g.channel_id}/subscription`,{subscribed:false},'PUT');
      button.textContent='Unfollowed';button.disabled=true;return;
    }
    if(action==='open'||action==='event-open'){
      const notice=action==='open'?g:this.events?.find(row=>row.id===Number(button.dataset.id));if(!notice)return;
      await this.mutate('/notifications/read',{ids:[notice.id]},'PUT');this.close();await this.open(notice);await this.refresh();return;
    }
    if(action==='expand'||action==='more-events'){
      const list=article.querySelector('.update-events');
      if(action==='expand'&&!list.hidden){list.hidden=true;button.setAttribute('aria-expanded','false');return;}
      const rows=await this.api('/notifications?group='+encodeURIComponent(g.group_key)+(action==='more-events'?'&before='+button.dataset.before:''));
      this.events=[...(this.events||[]),...rows];list.hidden=false;article.querySelector('[data-update=expand]').setAttribute('aria-expanded','true');
      if(action==='expand')list.innerHTML='';else button.remove();
      list.insertAdjacentHTML('beforeend',rows.map(row=>`<div class="update-event"><button data-update="event-open" data-id="${row.id}">${esc(row.actor?.display_name)} · ${esc(row.body.slice(0,160))}${row.read_at?'':' · Unread'}</button><button data-update="event-read" data-id="${row.id}" data-read="${!row.read_at}">${row.read_at?'Mark unread':'Mark read'}</button></div>`).join('')+(rows.length===50?`<button data-update="more-events" data-before="${rows.at(-1).id}">Older events</button>`:''));return;
    }
    if(action==='event-read'){await this.mutate('/notifications/read',{ids:[Number(button.dataset.id)],read:button.dataset.read==='true'},'PUT');await this.refresh();return;}
    if(action==='more-groups'){const page=await this.api('/notifications?view=overview&filter='+this.filter+'&before='+this.data.next);this.loadedPages=(this.loadedPages||1)+1;this.groups.push(...page.groups);this.data.next=page.next;this.renderGroups();}
  }
}
