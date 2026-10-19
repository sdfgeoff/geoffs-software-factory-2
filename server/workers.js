import { AppError, secret, digest, now, text } from './store.js';

const leaseMs = 90000;
const safeTools = new Set(['get_me','list_notifications','mark_notifications_read','subscribe_thread','unsubscribe_thread','list_tickets','read_ticket','create_ticket','update_ticket','add_ticket_comment','update_ticket_comment','edit_message','subscribe_ticket','unsubscribe_ticket','list_attachments','list_channels','read_channel','search_messages','subscribe','unsubscribe','post_message']);
const capacity = value => { const n = Number(value ?? 1); if (!Number.isInteger(n) || n < 1 || n > 8) throw new AppError('Capacity must be 1–8.'); return n; };
const limited = value => typeof value === 'string' ? value.slice(0, 1000) : null;
function authReport(input = {}) {
  input=input||{};
  const auth = { connected: input.connected === true, plan: limited(input.plan), error: limited(input.error) };
  if (input.flow && typeof input.flow === 'object') {
    let url = null;
    try { const parsed = new URL(input.flow.verification_url); if (parsed.protocol === 'https:' && parsed.hostname==='auth.openai.com' && !parsed.port && !parsed.username && !parsed.password) url = parsed.href; } catch {}
    auth.flow = { status: limited(input.flow.status), verification_url: url, user_code: limited(input.flow.user_code), error: limited(input.flow.error) };
  }
  return auth;
}
export class Workers {
  constructor(store) {
    this.store = store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS workers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,capacity INTEGER NOT NULL DEFAULT 1,
      enrollment_hash TEXT, enrollment_expires INTEGER, credential_hash TEXT,revoked INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'unregistered',auth TEXT NOT NULL DEFAULT '{}',models TEXT NOT NULL DEFAULT '[]',last_seen_at INTEGER,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS worker_commands(id INTEGER PRIMARY KEY AUTOINCREMENT,worker_id INTEGER NOT NULL REFERENCES workers(id),type TEXT NOT NULL,acked INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS worker_jobs(id INTEGER PRIMARY KEY AUTOINCREMENT,worker_id INTEGER NOT NULL REFERENCES workers(id),agent_id INTEGER NOT NULL REFERENCES agents(user_id),
        lease_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'active',depth INTEGER NOT NULL DEFAULT 1,posts INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,completed_at TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS one_agent_lease ON worker_jobs(agent_id) WHERE status='active';
      CREATE TABLE IF NOT EXISTS worker_job_notifications(job_id INTEGER NOT NULL REFERENCES worker_jobs(id),notification_id INTEGER NOT NULL,PRIMARY KEY(job_id,notification_id));
      CREATE TABLE IF NOT EXISTS worker_tool_results(job_id INTEGER NOT NULL REFERENCES worker_jobs(id),request_id TEXT NOT NULL,request_hash TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(job_id,request_id));
      CREATE TABLE IF NOT EXISTS worker_agent_state(worker_id INTEGER NOT NULL REFERENCES workers(id),agent_id INTEGER NOT NULL REFERENCES agents(user_id),thread_id TEXT,model TEXT,workspace_path TEXT,PRIMARY KEY(worker_id,agent_id));`);
    const fields = store.all('PRAGMA table_info(agents)').map(row => row.name);
    if (!fields.includes('worker_id')) store.db.exec('ALTER TABLE agents ADD COLUMN worker_id INTEGER REFERENCES workers(id)');
    if(!store.all('PRAGMA table_info(worker_jobs)').some(row=>row.name==='completion_hash'))store.db.exec('ALTER TABLE worker_jobs ADD COLUMN completion_hash TEXT');
    this.expire();
    store.db.exec("UPDATE agents SET status='thinking' WHERE user_id IN (SELECT agent_id FROM worker_jobs WHERE status='active')");
  }
  attachRuntime(agents) { this.agents = agents; }
  start() { this.timer = setInterval(() => this.expire(), 5000); this.timer.unref(); }
  stop() { clearInterval(this.timer); }
  row(id) { const value=Number(id); if(!Number.isSafeInteger(value)||value<1)throw new AppError('Invalid worker ID.'); const row = this.store.get('SELECT * FROM workers WHERE id=?', value); if (!row) throw new AppError('Worker not found.',404); return row; }
  public(row) { const {enrollment_hash,enrollment_expires,credential_hash,...worker}=row; return {...worker,auth:JSON.parse(row.auth),models:JSON.parse(row.models),online:!row.revoked && !['offline','stopping'].includes(row.status) && Boolean(row.last_seen_at && row.last_seen_at > Date.now()-45000)}; }
  list() { this.expire(); return this.store.all('SELECT * FROM workers ORDER BY id').map(row=>this.public(row)); }
  create(input) {
    const token=secret(); const id=Number(this.store.run('INSERT INTO workers(name,capacity,enrollment_hash,enrollment_expires,created_at) VALUES(?,?,?,?,?)',text(input.name,'Worker name',80),capacity(input.capacity),digest(token),Date.now()+3600000,now()).lastInsertRowid);
    this.store.onChange('workspace'); return {worker:this.public(this.row(id)),enrollment_token:token};
  }
  enroll(input) {
    if(typeof input.token!=='string') throw new AppError('Enrollment token required.',401);
    return this.store.transaction(()=>{
      const row=this.store.get('SELECT * FROM workers WHERE enrollment_hash=? AND enrollment_expires>? AND revoked=0',digest(input.token),Date.now());
      if(!row) throw new AppError('Enrollment token expired or already used.',401);
      const token=secret(); this.store.run("UPDATE workers SET credential_hash=?,enrollment_hash=NULL,enrollment_expires=NULL,status='starting' WHERE id=?",digest(token),row.id);
      return {worker_id:row.id,token};
    });
  }
  authenticate(token) { if(typeof token!=='string') throw new AppError('Worker credential required.',401); const row=this.store.get('SELECT * FROM workers WHERE credential_hash=? AND revoked=0',digest(token)); if(!row) throw new AppError('Invalid worker credential.',401); return row; }
  validateAssignment(value, previous=null) {
    if(value===undefined) return previous;
    if(value===null || value==='') return null;
    const id=Number(value); if(!Number.isSafeInteger(id)||id<1) throw new AppError('Invalid worker assignment.');
    const worker=this.row(id); if(worker.revoked && id!==previous) throw new AppError('Worker is revoked.'); return id;
  }
  update(id,input) {
    const row=this.row(id); const name=input.name===undefined?row.name:text(input.name,'Worker name',80); const cap=input.capacity===undefined?row.capacity:capacity(input.capacity);
    if(input.revoked!==undefined && typeof input.revoked!=='boolean') throw new AppError('Revoked must be boolean.');
    if(row.revoked && input.revoked===false) throw new AppError('Create a new enrollment instead of restoring revoked credentials.');
    this.store.transaction(()=>{this.store.run('UPDATE workers SET name=?,capacity=?,revoked=? WHERE id=?',name,cap,input.revoked===undefined?row.revoked:Number(input.revoked),row.id); if(input.revoked) {this.store.run('UPDATE workers SET credential_hash=NULL,enrollment_hash=NULL WHERE id=?',row.id); for(const job of this.store.all("SELECT * FROM worker_jobs WHERE worker_id=? AND status='active'",row.id)) this.release(job,'cancelled');}});
    this.store.onChange('workspace'); return this.public(this.row(row.id));
  }
  auth(id,input) { const row=this.row(id); if(row.revoked) throw new AppError('Worker is revoked.'); if(!['start','cancel','refresh'].includes(input.action)) throw new AppError('Invalid authentication action.'); this.store.run('INSERT INTO worker_commands(worker_id,type,created_at) VALUES(?,?,?)',row.id,`auth_${input.action}`,now()); return {ok:true}; }
  heartbeat(worker,input) {
    this.expire(); const auth=authReport(input.auth); const models=Array.isArray(input.models)?input.models.filter(model=>typeof model==='string'||model&&typeof model==='object').slice(0,100).map(model=>typeof model==='string'?{id:model.slice(0,100),name:model.slice(0,100)}:{id:limited(model.id||model.model),name:limited(model.name||model.displayName),default:model.default===true}):[];
    const status=['offline','stopping'].includes(input.status)?input.status:['pending','starting','awaiting_user'].includes(auth.flow?.status)?'authenticating':auth.connected?'ready':input.status==='error'?'error':'needs_auth';
    const running=Array.isArray(input.running)?input.running.filter(Number.isSafeInteger).slice(0,8):[];
    this.store.transaction(()=>{
      this.store.run('UPDATE workers SET auth=?,models=?,status=?,last_seen_at=? WHERE id=?',JSON.stringify(auth),JSON.stringify(models),status,Date.now(),worker.id);
      for(const id of Array.isArray(input.ack_commands)?input.ack_commands.slice(0,100):[]) if(Number.isSafeInteger(id)) this.store.run('UPDATE worker_commands SET acked=1 WHERE id=? AND worker_id=?',id,worker.id);
      for(const id of running) this.store.run("UPDATE worker_jobs SET expires_at=? WHERE id=? AND worker_id=? AND status='active'",Date.now()+leaseMs,id,worker.id);
    });
    const leases=this.store.all("SELECT id,expires_at FROM worker_jobs WHERE worker_id=? AND status='active'",worker.id); const active=leases.map(row=>row.id);
    this.store.onChange('workspace'); return {capacity:this.row(worker.id).capacity,commands:this.store.all('SELECT id,type FROM worker_commands WHERE worker_id=? AND acked=0 ORDER BY id',worker.id),active_leases:active,leases,lease_duration_ms:leaseMs,cancelled:running.filter(id=>!active.includes(id))};
  }
  release(job,status,error=null) {
    const rows=this.store.all('SELECT n.* FROM notifications n JOIN worker_job_notifications j ON j.notification_id=n.id WHERE j.job_id=?',job.id);
    for(const n of rows) {
      if(status==='completed') this.store.run('DELETE FROM notifications WHERE id=?',n.id);
      else if(error) this.store.run('UPDATE notifications SET status=?,attempts=attempts+1,due_at=? WHERE id=?',n.attempts>=4?'failed':'pending',Date.now()+Math.min(300000,30000*2**n.attempts),n.id);
      else this.store.run("UPDATE notifications SET status='pending' WHERE id=?",n.id);
    }
    this.store.run('UPDATE worker_jobs SET status=?,completed_at=? WHERE id=?',status,now(),job.id);
    this.store.run('DELETE FROM worker_tool_results WHERE job_id=?',job.id);
    this.store.run('DELETE FROM worker_job_notifications WHERE job_id=?',job.id);
    this.store.run('UPDATE agents SET status=?,last_error=? WHERE user_id=?',error?'error':'idle',error?String(error).slice(0,500):null,job.agent_id);
  }
  expire() {
    const stale=this.store.all("SELECT j.* FROM worker_jobs j JOIN agents a ON a.user_id=j.agent_id JOIN workers w ON w.id=j.worker_id JOIN users u ON u.id=a.user_id WHERE j.status='active' AND (j.expires_at<=? OR w.revoked=1 OR a.worker_id IS NOT j.worker_id OR a.enabled=0 OR u.disabled=1)",Date.now());
    if(stale.length) {this.store.transaction(()=>{for(const job of stale)this.release(job,'expired');});this.store.onChange('workspace');}
  }
  cancelAgent(id) { const job=this.store.get("SELECT * FROM worker_jobs WHERE agent_id=? AND status='active'",id); if(job)this.release(job,'cancelled'); }
  claim(worker) {
    this.expire(); const row=this.row(worker.id);
    if(row.revoked||row.status!=='ready'||!JSON.parse(row.auth).connected||row.last_seen_at<Date.now()-45000) return {job:null};
    const result=this.store.transaction(()=>{
      if(this.store.get("SELECT COUNT(*) count FROM worker_jobs WHERE worker_id=? AND status='active'",row.id).count>=row.capacity) return {job:null};
      const agent=this.store.get(`SELECT a.*,u.username,u.display_name FROM agents a JOIN users u ON u.id=a.user_id WHERE a.worker_id=? AND a.enabled=1 AND u.disabled=0
        AND NOT EXISTS(SELECT 1 FROM worker_jobs j WHERE j.agent_id=a.user_id AND j.status='active')
        AND EXISTS(SELECT 1 FROM notifications n WHERE n.agent_id=a.user_id AND n.status='pending' AND n.due_at<=?) ORDER BY a.last_run_at,a.user_id LIMIT 1`,row.id,Date.now());
      if(!agent)return {job:null};
      const notifications=this.store.all("SELECT * FROM notifications WHERE agent_id=? AND status='pending' AND due_at<=? ORDER BY id LIMIT 50",agent.user_id,Date.now());
      const context=this.agents?.notificationContext?this.agents.notificationContext(agent.user_id,notifications,'{{WORKSPACE}}'):{prompt:JSON.stringify(notifications),depth:Math.max(0,...notifications.map(n=>n.depth||0))+1};
      const leaseToken=secret(); const id=Number(this.store.run('INSERT INTO worker_jobs(worker_id,agent_id,lease_hash,expires_at,depth,created_at) VALUES(?,?,?,?,?,?)',row.id,agent.user_id,digest(leaseToken),Date.now()+leaseMs,context.depth,now()).lastInsertRowid);
      for(const n of notifications){this.store.run('INSERT INTO worker_job_notifications VALUES(?,?)',id,n.id);this.store.run("UPDATE notifications SET status='processing' WHERE id=?",n.id);}
      this.store.run("UPDATE agents SET status='thinking',last_error=NULL,last_run_at=? WHERE user_id=?",now(),agent.user_id);
      const state=this.store.get('SELECT * FROM worker_agent_state WHERE worker_id=? AND agent_id=?',row.id,agent.user_id);
      return {job:{id,job_id:id,expires_at:this.store.get('SELECT expires_at FROM worker_jobs WHERE id=?',id).expires_at,lease_duration_ms:leaseMs,lease_token:leaseToken,agent:{...agent,thread_id:state?.thread_id||null},notifications,prompt:context.prompt,depth:context.depth,thread_id:state?.thread_id||null}};
    });
    if(result.job)this.store.onChange('workspace');return result;
  }
  lease(worker,id,token,completed=false) {
    this.expire(); const job=this.store.get('SELECT * FROM worker_jobs WHERE id=? AND worker_id=?',Number(id),worker.id);
    if(!job||typeof token!=='string'||digest(token)!==job.lease_hash)throw new AppError('Invalid job lease.',403);
    if(completed && job.completion_hash && ['completed','failed','cancelled'].includes(job.status))return job;
    if(job.status!=='active'||job.expires_at<=Date.now())throw new AppError('Job lease expired or cancelled.',409);
    return job;
  }
  tool(worker,id,input) {
    const job=this.lease(worker,id,input.lease_token); const requestId=text(input.request_id,'Request ID',128); const hash=digest(JSON.stringify({name:input.name,input:input.input}));
    const previous=this.store.get('SELECT * FROM worker_tool_results WHERE job_id=? AND request_id=?',job.id,requestId);
    if(previous){if(previous.request_hash!==hash)throw new AppError('Request ID reused with different input.',409);return JSON.parse(previous.response);}
    const args=input.input||{}; const name=input.name;
    if(typeof args!=='object'||Array.isArray(args))throw new AppError('Tool input must be an object.');
    if(!safeTools.has(name)&&!['attach_bytes','read_attachment'].includes(name))throw new AppError('Tool must execute on the worker, not the server.',403);
    if(name==='read_attachment'&&('destination'in args||'path'in args))throw new AppError('Attachment destinations belong to the worker.',403);
    if(args.attachments && (!Array.isArray(args.attachments)||args.attachments.some(file=>!file||typeof file.content_base64!=='string'||'path'in file)))throw new AppError('Send prepared attachment bytes, not filesystem paths.');
    return this.store.transaction(()=>{
      let result; const state={agentId:job.agent_id,posts:job.posts,depth:job.depth,cancelled:false,remote:true};
      if(name==='attach_bytes') {if('path'in args||'destination'in args)throw new AppError('Remote paths are not accepted.',403);result=this.store.tickets.attach(job.agent_id,args,job.depth);}
      else if(name==='read_attachment')result=this.store.tickets.readAttachment(job.agent_id,Number(args.attachment_id));
      else {const token=secret();this.agents.tokens.set(token,state);try{result=this.agents.tool(token,name,args);}finally{this.agents.tokens.delete(token);}}
      this.store.run('UPDATE worker_jobs SET posts=? WHERE id=?',state.posts,job.id);
      this.store.run('INSERT INTO worker_tool_results VALUES(?,?,?,?)',job.id,requestId,hash,JSON.stringify(result));return result;
    });
  }
  complete(worker,id,input) {
    const job=this.lease(worker,id,input.lease_token,true);
    const completionHash=digest(JSON.stringify({thread_id:input.thread_id,model:input.model,workspace_path:input.workspace_path,error:input.error,cancelled:input.cancelled}));
    if(job.status!=='active'){if(job.completion_hash!==completionHash)throw new AppError('Completion retry changed its payload.',409);return {ok:true};}
    this.store.transaction(()=>{
      if(input.thread_id!==undefined)this.store.run(`INSERT INTO worker_agent_state(worker_id,agent_id,thread_id,model,workspace_path) VALUES(?,?,?,?,?) ON CONFLICT(worker_id,agent_id) DO UPDATE SET thread_id=excluded.thread_id,model=excluded.model,workspace_path=excluded.workspace_path`,worker.id,job.agent_id,limited(input.thread_id),limited(input.model),limited(input.workspace_path));
      this.store.run('UPDATE worker_jobs SET completion_hash=? WHERE id=?',completionHash,job.id);
      this.release(job,input.cancelled?'cancelled':input.error?'failed':'completed',input.cancelled?null:input.error);
    });this.store.onChange('workspace');return {ok:true};
  }
}
