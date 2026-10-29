'use strict';
const {DatabaseSync}=require('node:sqlite');
const fs=require('node:fs');
const path=require('node:path');

class SalesStore {
  constructor(filename=':memory:') {
    this.filename=filename;
    if(filename!==':memory:') fs.mkdirSync(path.dirname(path.resolve(filename)),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(filename);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS contacts(phone TEXT PRIMARY KEY,name TEXT,company_type TEXT,city TEXT,ad_experience TEXT);
      CREATE TABLE IF NOT EXISTS conversations(phone TEXT PRIMARY KEY REFERENCES contacts(phone),revision INTEGER NOT NULL DEFAULT 0,
        paused INTEGER NOT NULL DEFAULT 0,opted_out INTEGER NOT NULL DEFAULT 0,handoff_reason TEXT,
        summary TEXT NOT NULL DEFAULT '',last_inbound_at INTEGER,last_outbound_at INTEGER);
      CREATE TABLE IF NOT EXISTS seen_events(id TEXT PRIMARY KEY,received_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY,phone TEXT NOT NULL,revision INTEGER NOT NULL,kind TEXT NOT NULL,
        due_at INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'pending',payload TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,error TEXT,UNIQUE(phone,revision,kind));
      CREATE INDEX IF NOT EXISTS jobs_due ON jobs(state,due_at);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,phone TEXT NOT NULL,conversation_id TEXT NOT NULL REFERENCES conversations(phone),
        direction TEXT NOT NULL,body TEXT NOT NULL,type TEXT NOT NULL,timestamp INTEGER NOT NULL,status TEXT NOT NULL,
        job_id INTEGER,kind TEXT NOT NULL DEFAULT 'reply',received_at INTEGER);
      CREATE INDEX IF NOT EXISTS messages_history ON messages(conversation_id,timestamp);
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_calls(id INTEGER PRIMARY KEY,phone TEXT NOT NULL,timestamp INTEGER NOT NULL);`);
    // An in-flight send might have reached Meta before a restart: never repeat it.
    this.db.exec(`UPDATE conversations SET paused=1,handoff_reason='uncertain_send'
      WHERE phone IN(SELECT phone FROM jobs WHERE state='sending');
      UPDATE jobs SET state='uncertain',error='restart_during_send' WHERE state='sending';
      UPDATE jobs SET state='pending' WHERE state='running';`);
  }
  close(){this.db.close();}
  getMeta(key){return this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value;}
  setMeta(key,value){this.db.prepare('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,String(value));}
  see(id,at){return this.db.prepare('INSERT OR IGNORE INTO seen_events VALUES(?,?)').run(id,at).changes===1;}
  ensure(phone) {
    this.db.prepare('INSERT OR IGNORE INTO contacts(phone) VALUES(?)').run(phone);
    this.db.prepare('INSERT OR IGNORE INTO conversations(phone) VALUES(?)').run(phone);
  }
  conversation(phone){return this.db.prepare('SELECT * FROM conversations JOIN contacts USING(phone) WHERE phone=?').get(phone);}
  receive(msg,at) {
    this.ensure(msg.from);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if(!this.see(msg.id,at)){this.db.exec('COMMIT');return null;}
      this.db.prepare(`INSERT INTO messages(id,phone,conversation_id,direction,body,type,timestamp,status,received_at)
        VALUES(?,?,?,'received',?,?,?,'received',?)`).run(msg.id,msg.from,msg.from,
          msg.type==='text'?String(msg.text.body).slice(0,10000):`[${msg.type}]`,msg.type,Number(msg.timestamp)*1000,at);
      this.db.prepare('UPDATE conversations SET revision=revision+1,last_inbound_at=? WHERE phone=?').run(Number(msg.timestamp)*1000,msg.from);
      this.cancel(msg.from);
      this.db.exec('COMMIT');
    } catch(e){this.db.exec('ROLLBACK');throw e;}
    return this.conversation(msg.from);
  }
  cancel(phone){this.db.prepare("UPDATE jobs SET state='cancelled' WHERE phone=? AND kind!='notify' AND state IN('pending','running')").run(phone);}
  pause(phone,reason,optOut=false) {
    this.ensure(phone); this.cancel(phone);
    this.db.prepare('UPDATE conversations SET paused=1,opted_out=MAX(opted_out,?),handoff_reason=? WHERE phone=?').run(optOut?1:0,reason,phone);
  }
  resume(phone) {
    // Only an authenticated operator command may call this method.
    this.cancel(phone);
    this.db.prepare('UPDATE conversations SET paused=0,revision=revision+1,handoff_reason=NULL WHERE phone=? AND opted_out=0').run(phone);
    return this.conversation(phone);
  }
  permitFollowup(phone,evidenceId){this.setMeta('followup_permission:'+phone,evidenceId);}
  hasFollowupPermission(phone){return Boolean(this.getMeta('followup_permission:'+phone));}
  queue(){return this.db.prepare('SELECT phone,name,handoff_reason,opted_out FROM conversations JOIN contacts USING(phone) WHERE paused=1 ORDER BY last_inbound_at DESC LIMIT 20').all();}
  job(phone,revision,kind,due,payload,now) {
    this.db.prepare('INSERT OR IGNORE INTO jobs(phone,revision,kind,due_at,payload,created_at) VALUES(?,?,?,?,?,?)')
      .run(phone,revision,kind,due,JSON.stringify(payload),now);
  }
  due(now){return this.db.prepare("SELECT * FROM jobs WHERE state='pending' AND due_at<=? ORDER BY due_at,id LIMIT 20").all(now);}
  claim(id){return this.db.prepare("UPDATE jobs SET state='running' WHERE id=? AND state='pending'").run(id).changes===1;}
  jobState(id){return this.db.prepare('SELECT state FROM jobs WHERE id=?').get(id)?.state;}
  finish(id,state,error=null){this.db.prepare('UPDATE jobs SET state=?,error=? WHERE id=?').run(state,error,id);}
  defer(id,due,payload){this.db.prepare("UPDATE jobs SET state='pending',due_at=?,payload=? WHERE id=? AND state='running'").run(due,JSON.stringify(payload),id);}
  history(phone) {
    const rows=this.db.prepare(`SELECT direction,body FROM messages WHERE conversation_id=? AND kind!='notify'
      AND (direction='received' OR status IN('accepted','sent','delivered','read')) ORDER BY timestamp DESC,rowid DESC LIMIT 24`).all(phone).reverse();
    // Cap the prompt size independently of the number of stored messages.
    let remaining=18000;
    return rows.reverse().map(r=>{const body=r.body.slice(0,Math.max(0,remaining));remaining-=body.length;return {role:r.direction==='received'?'user':'assistant',content:body};})
      .filter(x=>x.content).reverse();
  }
  saveFacts(phone,d) {
    this.db.prepare(`UPDATE contacts SET name=COALESCE(?,name),company_type=COALESCE(?,company_type),
      city=COALESCE(?,city),ad_experience=COALESCE(?,ad_experience) WHERE phone=?`)
      .run(d.name,d.company_type,d.city,d.ad_experience,phone);
    this.db.prepare('UPDATE conversations SET summary=? WHERE phone=?').run(d.summary,phone);
  }
  accepted(job,outgoing,body,now,recipient=job.phone) {
    this.ensure(job.phone);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO messages(id,phone,conversation_id,direction,body,type,timestamp,status,job_id,kind)
        VALUES(?,?,?,'sent',?,'text',?,'accepted',?,?)`).run(outgoing,recipient,job.phone,body,now,job.id,job.kind);
      const receivedAt=JSON.parse(job.payload).receivedAt;
      if(receivedAt)this.db.prepare('UPDATE messages SET received_at=? WHERE id=?').run(receivedAt,outgoing);
      if(job.kind!=='notify') this.db.prepare('UPDATE conversations SET last_outbound_at=? WHERE phone=?').run(now,job.phone);
      this.finish(job.id,'sent'); this.db.exec('COMMIT');
    } catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  status(status) {
    const row=this.db.prepare('SELECT * FROM messages WHERE id=? AND direction=\'sent\'').get(status.id);
    if(!row) return null;
    const rank={accepted:0,sent:1,delivered:2,read:3,failed:4};
    if(status.status in rank && (rank[status.status]>=rank[row.status]) && !(status.status==='failed'&&['delivered','read'].includes(row.status)))
      this.db.prepare('UPDATE messages SET status=? WHERE id=?').run(status.status,status.id);
    return row;
  }
  allowAi(phone,now,max=30) {
    const count=this.db.prepare('SELECT COUNT(*) AS n FROM ai_calls WHERE phone=? AND timestamp>?').get(phone,now-86400000).n;
    if(count>=max)return false;
    this.db.prepare('INSERT INTO ai_calls(phone,timestamp) VALUES(?,?)').run(phone,now);
    return true;
  }
}
module.exports={SalesStore};
