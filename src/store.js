import { DatabaseSync } from 'node:sqlite';

export class Store {
  constructor(filename) {
    this.owner = new DatabaseSync(filename === ':memory:' ? ':memory:' : `${filename}.owner`);
    try { this.owner.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner_lock(id INTEGER);'); }
    catch { this.owner.close(); throw new Error('POOL_ALREADY_RUNNING'); }
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 2) { this.db.close(); this.owner.close(); throw new Error('Unsupported database version'); }
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
    CREATE TABLE IF NOT EXISTS preflight (scope TEXT PRIMARY KEY, entry TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS exit_hooks (
      task_id TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0
    );
    PRAGMA user_version=2;`);
    this.db.prepare("UPDATE tasks SET state='needs_review', error='INTERRUPTED', updated=? WHERE state IN ('starting','running','cancelling')").run(new Date().toISOString());
    this.recoverHooks();
    this.pruneHistory();
  }
  byKey(key) { return this.db.prepare('SELECT * FROM tasks WHERE key=?').get(key); }
  get(id) { return this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id); }
  list(limit = 50, offset = 0, activeFirst = false) { return this.db.prepare("SELECT id,state,created,updated,error,workspace,json_extract(request,'$.routeId') AS routeId,json_extract(request,'$.modelId') AS modelId,json_extract(request,'$.kind') AS kind,json_extract(request,'$.mode') AS mode,json_extract(request,'$.group') AS 'group',json_extract(request,'$.effort') AS effort,json_extract(request,'$.clientLabel') AS clientLabel FROM tasks ORDER BY "+(activeFirst?"state IN ('queued','starting','running','cancelling') DESC, ":'')+"created DESC, rowid DESC LIMIT ? OFFSET ?").all(limit, offset); }
  queued() { return this.db.prepare("SELECT * FROM tasks WHERE state='queued' ORDER BY created, rowid").all(); }
  held() { return this.db.prepare("SELECT id,state,workspace,json_extract(request,'$.kind') AS kind FROM tasks WHERE state IN ('starting','running','cancelling','needs_review')").all(); }
  insert(task) {
    const now = new Date().toISOString();
    this.db.exec('SAVEPOINT insert_task');
    try {
      this.db.prepare('INSERT INTO tasks(id,key,fingerprint,state,workspace,request,created,updated) VALUES(?,?,?,?,?,?,?,?)')
        .run(task.id, task.key, task.fingerprint, 'queued', task.workspace, JSON.stringify(task.request), now, now);
      if (task.request.onExit) this.db.prepare('INSERT INTO exit_hooks(task_id) VALUES(?)').run(task.id);
      this.db.exec('RELEASE insert_task');
    } catch (error) { this.db.exec('ROLLBACK TO insert_task; RELEASE insert_task'); throw error; }
  }

  update(id, state, result = null, error = null) {
    this.db.prepare('UPDATE tasks SET state=?,result=?,error=?,updated=? WHERE id=?').run(state, result, error, new Date().toISOString(), id);
    this.event(id, 'state', state);
    if (['succeeded','failed','timed_out','cancelled'].includes(state)) this.pruneHistory();
  }
  event(id, kind, detail) { this.db.prepare('INSERT INTO events(task_id,time,kind,detail) VALUES(?,?,?,?)').run(id, new Date().toISOString(), kind, detail); }
  events(id, after = 0) { return this.db.prepare('SELECT seq,time,kind,detail FROM events WHERE task_id=? AND seq>? ORDER BY seq LIMIT 100').all(id, after); }
  notifications(id) { return this.db.prepare("SELECT detail FROM events WHERE task_id=? AND kind='notification' ORDER BY seq DESC LIMIT 10").all(id).map(row => row.detail); }
  reportedModel(id) { return this.db.prepare("SELECT detail FROM events WHERE task_id=? AND kind='progress' AND detail LIKE 'model:%' ORDER BY seq DESC LIMIT 1").get(id)?.detail.slice(6) || null; }
  errorDetail(id) { return this.db.prepare("SELECT detail FROM events WHERE task_id=? AND kind='error_detail' ORDER BY seq DESC LIMIT 1").get(id)?.detail || null; }
  interrupted() { return this.db.prepare("SELECT * FROM tasks WHERE state='needs_review' AND error='INTERRUPTED' ORDER BY rowid").all(); }
  snapshot(id) { return this.db.prepare("SELECT detail FROM events WHERE task_id=? AND kind='workspace_snapshot' ORDER BY seq DESC LIMIT 1").get(id)?.detail || null; }
  quota(routeId) { const row = this.db.prepare('SELECT snapshot FROM quotas WHERE route_id=?').get(routeId); return row ? JSON.parse(row.snapshot) : null; }
  saveQuota(routeId, snapshot) { this.db.prepare('INSERT INTO quotas(route_id,snapshot) VALUES(?,?) ON CONFLICT(route_id) DO UPDATE SET snapshot=excluded.snapshot').run(routeId, JSON.stringify(snapshot)); }
  pruneHistory(before = new Date(Date.now()-7*86400_000).toISOString()) {
    // Expire completed records and their admission keys together; never erase quarantine.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const expired = "SELECT id FROM tasks WHERE state IN ('succeeded','failed','timed_out','cancelled') AND id NOT IN (SELECT task_id FROM exit_hooks WHERE state!='done') AND (updated<? OR id IN (SELECT id FROM tasks WHERE state IN ('succeeded','failed','timed_out','cancelled') ORDER BY updated DESC,rowid DESC LIMIT -1 OFFSET 500))";
      this.db.prepare('DELETE FROM events WHERE task_id IN ('+expired+')').run(before);
      this.db.prepare('DELETE FROM exit_hooks WHERE task_id IN ('+expired+')').run(before);
      const removed = this.db.prepare('DELETE FROM tasks WHERE id IN ('+expired+')').run(before).changes;
      this.db.exec('COMMIT');
      return { removed };
    } catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  preflightForTask(id) {
    const event = this.db.prepare("SELECT detail FROM events WHERE task_id=? AND kind='preflight' ORDER BY seq DESC LIMIT 1").get(id);
    return event ? JSON.parse(event.detail) : null;
  }
  // Preflight results, one current entry per route/model/workspace/capability scope.
  preflight(scope) { const row = this.db.prepare('SELECT entry FROM preflight WHERE scope=?').get(scope); return row ? JSON.parse(row.entry) : null; }
  savePreflight(scope, entry) { this.db.prepare('INSERT INTO preflight(scope,entry) VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET entry=excluded.entry').run(scope, JSON.stringify(entry)); }
  hook(id) { return this.db.prepare('SELECT * FROM exit_hooks WHERE task_id=?').get(id); }
  pendingHooks(now = Date.now()) { return this.db.prepare("SELECT h.*,t.request FROM exit_hooks h JOIN tasks t ON t.id=h.task_id WHERE h.state='pending' AND h.next_at<=? AND t.state IN ('succeeded','failed','timed_out','cancelled','needs_review')").all(now); }
  claimHook(id) { return this.db.prepare("UPDATE exit_hooks SET state='running',attempts=attempts+1 WHERE task_id=? AND state='pending'").run(id).changes; }
  finishHook(id, retryAt = null) { this.db.prepare('UPDATE exit_hooks SET state=?,next_at=? WHERE task_id=?').run(retryAt === null ? 'done' : 'pending', retryAt || 0, id); }
  recoverHooks() {
    // An uncertain launch cannot be replayed safely; PB recover is idempotent and can be invoked manually.
    this.db.exec("UPDATE exit_hooks SET state='done' WHERE state='running'");
  }
  children(parentId) { return this.db.prepare("SELECT id,state,error FROM tasks WHERE json_extract(request,'$.parentTaskId')=? ORDER BY rowid").all(parentId); }
  clearHistory() { return this.pruneHistory('9999-01-01'); }
  close() { this.db.close(); this.owner.close(); }
}
