import { renderMarkdown } from '/markdown.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const fileId = file => `${file.name}:${file.size}:${file.lastModified}`;
let sequence = 0;

// One draft editor for messages, replies, ticket comments and their edit states.
// Files remain browser-local until the parent submits one atomic save.
export class Composer {
  constructor(form, { textareaId, label='Write a message', placeholder='', mode='comment', submitLabel='Post comment', submitAria=submitLabel, body='', attachments=[], onSubmit, onCancel, getMentionUsers = () => [] } = {}) {
    this.getMentionUsers=getMentionUsers;this.mentionMatches=[];this.mentionIndex=0;
    this.form=form;this.mode=mode;this.onSubmit=onSubmit;this.onCancel=onCancel;this.submitLabel=submitLabel;this.existing=attachments;this.removed=new Set();this.files=[];this.urls=[];this.revision=0;this.busy=false;
    const id=`composer-${++sequence}`;
    form.editor=this;form.classList.add('shared-composer');form.dataset.editorMode=mode;
    form.innerHTML=`<div class="editor-toolbar"><div class="editor-tabs" role="tablist" aria-label="Editor view"><button type="button" role="tab" id="${id}-write" aria-controls="${id}-write-panel" aria-selected="true" data-editor-tab="write">Write</button><button type="button" role="tab" id="${id}-preview" aria-controls="${id}-preview-panel" aria-selected="false" data-editor-tab="preview">Preview</button></div><div class="editor-formatting" role="group" aria-label="Formatting"><button type="button" data-format="bold" aria-label="Bold"><strong>B</strong></button><button type="button" data-format="italic" aria-label="Italic"><em>I</em></button><button type="button" data-format="list" aria-label="Bulleted list">≡</button><button type="button" data-format="code" aria-label="Code">&lt;/&gt;</button><button type="button" data-format="link" aria-label="Insert link">↗</button></div></div><div class="editor-write" id="${id}-write-panel" role="tabpanel" aria-labelledby="${id}-write"><label class="sr-only" for="${textareaId}">${esc(label)}</label><textarea id="${textareaId}" name="body" rows="${mode==='edit'?4:2}" placeholder="${esc(placeholder)}" maxlength="12000" aria-autocomplete="list" aria-controls="${id}-mentions" aria-expanded="false"></textarea><div id="${id}-mentions" class="editor-mentions" role="listbox" aria-label="Mention a person or agent" hidden></div></div><div id="${id}-preview-panel" class="composer-preview markdown-content" role="tabpanel" aria-labelledby="${id}-preview" hidden></div><div class="editor-files chat-selected-files" aria-live="polite"></div><div class="form-feedback" role="alert"></div><div class="editor-footer"><label class="editor-file-picker chat-file-picker"><span aria-hidden="true">＋</span><span>Attach files</span><input type="file" name="files" multiple aria-label="${esc(`Attach files to ${label.toLowerCase()}`)}"></label><span class="editor-shortcut">${mode==='chat'?'Enter to send':'Ctrl / ⌘ Enter'}</span><div class="editor-actions">${onCancel?'<button class="button subtle compact" type="button" data-editor-cancel>Cancel</button>':''}<button class="button primary compact" type="submit" aria-label="${esc(submitAria)}">${esc(submitLabel)}</button></div></div>`;
    this.input=form.querySelector('textarea');this.picker=form.querySelector('input[type=file]');this.mentionList=form.querySelector('.editor-mentions');this.preview=form.querySelector('.composer-preview');this.feedback=form.querySelector('.form-feedback');this.input.value=body;
    form.addEventListener('submit',event=>{event.preventDefault();event.stopImmediatePropagation();this.submit();});
    form.addEventListener('click',event=>{
      const button=event.target.closest('button');if(!button)return;
      if(button.hasAttribute('data-mention-index')){this.chooseMention(Number(button.dataset.mentionIndex));return;}
      if(button.dataset.editorTab){this.tab(button.dataset.editorTab);return;}
      if(button.dataset.format){this.format(button.dataset.format);return;}
      if(button.hasAttribute('data-editor-cancel')){if(!this.busy)this.onCancel?.();return;}
      if(button.hasAttribute('data-remove-file')){if(this.busy)return;const index=Number(button.dataset.removeFile);this.files.splice(index,1);this.syncPicker();this.renderFiles();return;}
      if(button.hasAttribute('data-remove-existing')){if(this.busy)return;const id=Number(button.dataset.removeExisting);if(this.removed.has(id))this.removed.delete(id);else this.removed.add(id);this.renderFiles();}
    });
    this.picker.addEventListener('change',()=>{this.addFiles([...this.picker.files]);});
    this.input.addEventListener('input',()=>{this.updateMentions();if(!this.preview.hidden)this.preview.innerHTML=renderMarkdown(this.input.value);});
    this.mentionList.addEventListener('mousedown',event=>event.preventDefault());
    this.input.addEventListener('click',()=>this.updateMentions());
    this.input.addEventListener('keyup',event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key))this.updateMentions();});
    this.input.addEventListener('keydown',event=>{
      if(!this.mentionList.hidden && ['ArrowDown','ArrowUp','Enter','Tab','Escape'].includes(event.key)){
        event.preventDefault();event.stopImmediatePropagation();
        if(event.key==='Escape')this.hideMentions();
        else if(event.key==='ArrowDown'||event.key==='ArrowUp'){this.mentionIndex=(this.mentionIndex+(event.key==='ArrowDown'?1:-1)+this.mentionMatches.length)%this.mentionMatches.length;this.renderMentions();}
        else this.chooseMention(this.mentionIndex);
        return;
      }
      if(event.key==='Enter'&&(event.ctrlKey||event.metaKey||(mode==='chat'&&!event.shiftKey&&!event.isComposing))){event.preventDefault();event.stopPropagation();this.submit();}
      else if(event.key==='Enter')event.stopPropagation();
    });
    form.addEventListener('dragover',event=>{if([...event.dataTransfer.types].includes('Files')){event.preventDefault();form.classList.add('editor-dragover');}});
    form.addEventListener('dragleave',event=>{if(!form.contains(event.relatedTarget))form.classList.remove('editor-dragover');});
    form.addEventListener('drop',event=>{if(event.dataTransfer.files.length){event.preventDefault();event.stopPropagation();form.classList.remove('editor-dragover');this.addFiles([...event.dataTransfer.files]);}});
    this.input.addEventListener('paste',event=>{const images=[...(event.clipboardData?.items||[])].filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).filter(Boolean);if(images.length){event.preventDefault();this.addFiles(images);}});
    this.renderFiles();
  }
  updateMentions(){
    if(this.busy||this.input.selectionStart!==this.input.selectionEnd){this.hideMentions();return;}
    const prefix=this.input.value.slice(0,this.input.selectionStart),match=prefix.match(/(?:^|[\s(])@([a-zA-Z0-9_.-]*)$/);
    if(!match||match[1].length>32){this.hideMentions();return;}
    const query=match[1].toLowerCase();this.mentionStart=this.input.selectionStart-query.length-1;this.mentionEnd=this.input.selectionStart;
    this.mentionMatches=this.getMentionUsers().filter(user=>!user.disabled&&(user.username.toLowerCase().startsWith(query)||user.display_name.toLowerCase().startsWith(query))).slice(0,6);
    if(!this.mentionMatches.length){this.hideMentions();return;}this.mentionIndex=0;this.renderMentions();
  }
  renderMentions(){this.mentionList.hidden=false;this.input.setAttribute('aria-expanded','true');this.mentionList.innerHTML=this.mentionMatches.map((user,index)=>`<button type="button" role="option" tabindex="-1" id="${this.mentionList.id}-${index}" aria-selected="${index===this.mentionIndex}" data-mention-index="${index}"><span class="mention-option-avatar">${user.kind==='agent'?'✧':esc(user.display_name[0])}</span><span><strong>${esc(user.display_name)}</strong><small>@${esc(user.username)}</small></span>${user.kind==='agent'?'<span class="ai-badge">AI</span>':''}</button>`).join('');this.input.setAttribute('aria-activedescendant',`${this.mentionList.id}-${this.mentionIndex}`);}
  hideMentions(){this.mentionList.hidden=true;this.input.setAttribute('aria-expanded','false');this.input.removeAttribute('aria-activedescendant');}
  chooseMention(index){const user=this.mentionMatches[index];if(!user)return;this.input.setRangeText(`@${user.username} `,this.mentionStart,this.mentionEnd,'end');this.hideMentions();this.input.focus();this.input.dispatchEvent(new Event('input',{bubbles:true}));}
  tab(name){this.hideMentions();const preview=name==='preview';this.form.querySelector('.editor-write').hidden=preview;this.preview.hidden=!preview;for(const tab of this.form.querySelectorAll('[data-editor-tab]'))tab.setAttribute('aria-selected',String(tab.dataset.editorTab===name));if(preview)this.preview.innerHTML=renderMarkdown(this.input.value)||'<p class="editor-empty-preview">Nothing to preview yet.</p>';else this.input.focus();}
  format(type){if(this.busy)return;this.tab('write');const input=this.input,start=input.selectionStart,end=input.selectionEnd,selected=input.value.slice(start,end);let insertion,offset=0;
    if(type==='bold'){insertion=`**${selected||'bold text'}**`;offset=2;}else if(type==='italic'){insertion=`*${selected||'italic text'}*`;offset=1;}else if(type==='code'){insertion=selected.includes('\n')?`\n\`\`\`\n${selected}\n\`\`\`\n`:`\`${selected||'code'}\``;offset=1;}else if(type==='list'){insertion=(selected||'List item').split('\n').map(line=>`- ${line}`).join('\n');offset=2;}else{insertion=`[${selected||'link text'}](https://example.com)`;offset=1;}
    input.setRangeText(insertion,start,end,'end');input.focus();if(!selected)input.setSelectionRange(start+offset,start+insertion.length-(type==='link'?22:offset));input.dispatchEvent(new Event('input',{bubbles:true}));
  }
  addFiles(files){if(this.busy)return;const merged=[...this.files];for(const file of files)if(!merged.some(existing=>fileId(existing)===fileId(file)))merged.push(file);const retained=this.existing.filter(a=>!this.removed.has(a.id));if(merged.length>10){this.error('Add at most 10 new files per save.');this.syncPicker();return;}if(merged.reduce((sum,file)=>sum+file.size,0)>10*1024*1024){this.error('New files must total 10 MB or less per save.');this.syncPicker();return;}this.files=merged;this.syncPicker();this.renderFiles();this.error('');}
  syncPicker(){const transfer=new DataTransfer();this.files.forEach(file=>transfer.items.add(file));this.picker.files=transfer.files;}
  renderFiles(){this.urls.forEach(url=>URL.revokeObjectURL(url));this.urls=[];const existing=this.existing.map(file=>{const removed=this.removed.has(file.id);return `<div class="editor-file existing-file ${removed?'is-removed':''}">${file.is_image?`<img src="/api/attachments/${Number(file.id)}/content" alt="${esc(file.filename)}">`:'<span class="editor-file-symbol" aria-hidden="true">↗</span>'}<span>${esc(file.filename)}<small>${removed?'Will be removed':'Attached'}</small></span><button type="button" data-remove-existing="${file.id}" aria-label="${removed?'Keep':'Remove'} ${esc(file.filename)}" ${this.busy?'disabled':''}>${removed?'Undo':'×'}</button></div>`;});
    const staged=this.files.map((file,index)=>{const isImage=/^image\/(png|jpeg|gif|webp)$/.test(file.type),url=isImage?URL.createObjectURL(file):null;if(url)this.urls.push(url);return `<div class="editor-file">${url?`<img src="${url}" alt="Selected image ${esc(file.name)}">`:'<span class="editor-file-symbol" aria-hidden="true">↗</span>'}<span>${esc(file.name)}<small>Ready to ${this.mode==='edit'?'save':'send'}</small></span><button type="button" data-remove-file="${index}" aria-label="Remove ${esc(file.name)}" ${this.busy?'disabled':''}>×</button></div>`;});this.form.querySelector('.editor-files').innerHTML=[...existing,...staged].join('');}
  error(message){this.feedback.textContent=message;this.feedback.classList.toggle('form-error',Boolean(message));}
  snapshot(){return {body:this.input.value,files:[...this.files],removed:[...this.removed],selection:[this.input.selectionStart,this.input.selectionEnd],preview:!this.preview.hidden};}
  restore(draft={}){this.hideMentions();this.revision++;this.busy=false;this.input.value=draft.body||'';this.files=[...(draft.files||[])];this.removed=new Set(draft.removed||[]);this.syncPicker();this.renderFiles();this.setBusy(false);this.error('');this.tab(draft.preview?'preview':'write');if(draft.selection)this.input.setSelectionRange(...draft.selection);}
  clear(){this.restore({});}
  setBusy(value){this.busy=value;this.input.readOnly=value;for(const button of this.form.querySelectorAll('button'))button.disabled=value;this.picker.disabled=value;}
  async payload(){const attachments=[];for(const file of this.files){const content=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error(`Could not read ${file.name}.`));reader.readAsDataURL(file);});attachments.push({filename:file.name,content_base64:content});}return {body:this.input.value.trim(),attachments,remove_attachment_ids:[...this.removed]};}
  async submit(){if(this.busy)return;this.hideMentions();const body=this.input.value.trim(),retained=this.existing.filter(a=>!this.removed.has(a.id));if(!body&&!this.files.length&&!retained.length){this.error('Write something or attach a file.');return;}const revision=this.revision;this.setBusy(true);this.error('');try{const payload=await this.payload();await this.onSubmit(payload);if(this.revision===revision&&this.form.isConnected&&this.mode!=='edit'){this.clear();this.input.focus();}}catch(error){if(this.revision===revision&&this.form.isConnected)this.error(error.message||'Could not save. Your draft is still here.');}finally{if(this.revision===revision&&this.form.isConnected)this.setBusy(false);}}
  destroy(){this.urls.forEach(url=>URL.revokeObjectURL(url));this.urls=[];}
}
