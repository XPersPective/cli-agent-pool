import { DatabaseSync } from 'node:sqlite';

export class Store {
  constructor(filename) {
    this.owner = new DatabaseSync(filename === ':memory:' ? ':memory:' : `${filename}.owner`);
    try { this.owner.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner_lock(id INTEGER);'); }
    catch { this.owner.close(); throw new Error('POOL_ALREADY_RUNNING'); }
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) { this.db.close(); this.owner.close(); throw new Error('Unsupported database version'); }
    this.db.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
      state TEXT NOT NULL, workspace TEXT NOT NULL, request TEXT NOT NULL,
      created TEXT NOT NULL, updated TEXT NOT NULL, result TEXT, error TEXT
    );
    CREATE INDEX IF NOT EXISTS task_state ON tasks(state, created);
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
      time TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS quotas (route_id TEXT PRIMARY KEY, snapshot TEXT NOT NULL);
    PRAGMA user_version=1;`);
    this.db.prepare("UPDATE tasks SET state='needs_review', error='INTERRUPTED', updated=? WHERE state IN ('starting','running','cancelling')").run(new Date().toISOString());
    this.pruneHistory();
  }
  byKey(key) { return this.db.prepare('SELECT * FROM tasks WHERE key=?').get(key); }
  get(id) { return this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id); }
  list(limit = 50, offset = 0, activeFirst = false) { return this.db.prepare("SELECT id,state,created,updated,error,workspace,json_extract(request,'$.routeId') AS routeId,json_extract(request,'$.modelId') AS modelId,json_extract(request,'$.kind') AS kind,json_extract(request,'$.mode') AS mode,json_extract(request,'$.group') AS 'group',json_extract(request,'$.effort') AS effort,json_extract(request,'$.clientLabel') AS clientLabel FROM tasks ORDER BY "+(activeFirst?"state IN ('queued','starting','running','cancelling') DESC, ":'')+"created DESC, rowid DESC LIMIT ? OFFSET ?").all(limit, offset); }
  queued() { return this.db.prepare("SELECT * FROM tasks WHERE state='queued' ORDER BY created, rowid").all(); }
  held() { return this.db.prepare("SELECT id,state,workspace,json_extract(request,'$.kind') AS kind FROM tasks WHERE state IN ('starting','running','cancelling','needs_review')").all(); }
  insert(task) {
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO tasks(id,key,fingerprint,state,workspace,request,created,updated) VALUES(?,?,?,?,?,?,?,?)')
      .run(task.id, task.key, task.fingerprint, 'queued', task.workspace, JSON.stringify(task.request), now, now);
  }
  update(id, state, result = null, error = null) {
    this.db.prepare('UPDATE tasks SET state=?,result=?,error=?,updated=? WHERE id=?').run(state, result, error, new Date().toISOString(), id);
    this.event(id, 'state', state);
  }
  event(id, kind, detail) { this.db.prepare('INSERT INTO events(task_id,time,kind,detail) VALUES(?,?,?,?)').run(id, new Date().toISOString(), kind, detail); }
  events(id, after = 0) { return this.db.prepare('SELECT seq,time,kind,detail FROM events WHERE task_id=? AND seq>? ORDER BY seq LIMIT 100').all(id, after); }
  reportedModel(id) { return this.db.prepare("SELECT detail FROM events WHERE task_id=? AND kind='progress' AND detail LIKE 'model:%' ORDER BY seq DESC LIMIT 1").get(id)?.detail.slice(6) || null; }
  quota(routeId) { const row = this.db.prepare('SELECT snapshot FROM quotas WHERE route_id=?').get(routeId); return row ? JSON.parse(row.snapshot) : null; }
  saveQuota(routeId, snapshot) { this.db.prepare('INSERT INTO quotas(route_id,snapshot) VALUES(?,?) ON CONFLICT(route_id) DO UPDATE SET snapshot=excluded.snapshot').run(routeId, JSON.stringify(snapshot)); }
  pruneHistory(before = new Date(Date.now()-7*86400_000).toISOString()) {
    // Keep admission keys/fingerprints and quarantine; only completed payloads expire.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE tasks SET request=json_set(json_remove(request,'$.prompt'),'$.historyExpired',json('true')), result=NULL WHERE state IN ('succeeded','failed','timed_out','cancelled') AND (updated<? OR id IN (SELECT id FROM tasks WHERE state IN ('succeeded','failed','timed_out','cancelled') ORDER BY updated DESC,rowid DESC LIMIT -1 OFFSET 500))").run(before);
      this.db.prepare("DELETE FROM events WHERE task_id IN (SELECT id FROM tasks WHERE json_extract(request,'$.historyExpired')=1)").run();
      this.db.exec('COMMIT');
    } catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  close() { this.db.close(); this.owner.close(); }
}
