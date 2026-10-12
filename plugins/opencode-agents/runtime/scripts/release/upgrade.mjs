// Offline upgrade/rollback rehearsal using a real previous compiled runtime.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SqliteTaskStore } from '../../dist/store.js';
import { ArtifactStore } from '../../dist/artifacts.js';
const args=process.argv.slice(2),opt=name=>args[args.indexOf(name)+1];
assert(args.includes('--previous-runtime')&&args.includes('--out'));
const previous=resolve(opt('--previous-runtime')),out=resolve(opt('--out'));mkdirSync(out);
const {SqliteTaskStore:PreviousStore}=await import(pathToFileURL(join(previous,'dist/store.js')).href);
const sha=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const filename=join(out,'state.sqlite'),backup=join(out,'rollback.sqlite');
const artifacts=new ArtifactStore(join(out,'artifacts'));
const old=new PreviousStore(filename);
let task=old.start({scopeId:'upgrade',idempotencyKey:'upgrade-initial-task-0001',workspace:join(out,'workspace'),
  packet:{objective:'Historical task'},model:'fake/model',profile:'bounded-inspect',baselineHash:'a'.repeat(64),promptHash:'b'.repeat(64)});
const artifact=artifacts.captureBytes(task.executionId,Buffer.from('preserved immutable evidence\n'),'text/plain',entry=>old.registerArtifact(entry));
task=old.cancelTask({scopeId:task.scopeId,taskId:task.taskId,executionId:task.executionId,expectedRevision:task.revision,
  idempotencyKey:'upgrade-cancel-task-0001',reason:'Drain before upgrade',requester:'parent'});
assert.equal(old.unresolved().length,0);
const db=new DatabaseSync(filename);
db.exec("PRAGMA journal_mode=WAL; CREATE TABLE historical_bytes(value BLOB); INSERT INTO historical_bytes VALUES(X'000102ff')");
db.prepare('VACUUM INTO ?').run(backup);
const committedWal= new DatabaseSync(backup,{readOnly:true});
assert.equal(committedWal.prepare('SELECT hex(value) AS value FROM historical_bytes').get().value,'000102FF');committedWal.close();
db.close();old.close();
const next=new SqliteTaskStore(filename);
assert.deepEqual(next.get(task.scopeId,task.taskId),task);
assert.equal(artifacts.read(next.artifact(task.executionId,artifact.artifactId)).bytes.toString(),'preserved immutable evidence\n');
let added=next.start({scopeId:'upgrade',idempotencyKey:'upgrade-new-task-0001',workspace:join(out,'workspace'),
  packet:{objective:'New runtime task'},model:'fake/model',profile:'bounded-inspect',baselineHash:'c'.repeat(64),promptHash:'d'.repeat(64)});
next.cancelTask({scopeId:added.scopeId,taskId:added.taskId,executionId:added.executionId,expectedRevision:added.revision,
  idempotencyKey:'upgrade-cancel-new-0001',reason:'Drain before rollback',requester:'parent'});
assert.equal(next.unresolved().length,0);next.close();
assert(!readdirSync(out).some(n=>n.endsWith('-wal')||n.endsWith('-shm')),'writer not drained');
copyFileSync(filename,join(out,'upgraded-retained.sqlite'));
copyFileSync(backup,filename);
const restored=new PreviousStore(filename);
assert.deepEqual(restored.get(task.scopeId,task.taskId),task);
assert.equal(restored.get(added.scopeId,added.taskId),null);
assert.equal(artifacts.read(restored.artifact(task.executionId,artifact.artifactId)).bytes.toString(),'preserved immutable evidence\n');
restored.close();
const future=join(out,'future.sqlite');const futureDb=new DatabaseSync(future);
futureDb.exec('CREATE TABLE schema_version(version INTEGER); INSERT INTO schema_version VALUES(4)');futureDb.close();
assert.throws(()=>new PreviousStore(future),/newer/);assert.throws(()=>new SqliteTaskStore(future),/newer/);
writeFileSync(join(out,'result.json'),JSON.stringify({status:'passed',node:process.version,platform:process.platform,
  previous_store_sha256:sha(join(previous,'dist/store.js')),candidate_store_sha256:sha(new URL('../../dist/store.js',import.meta.url)),
  rollback_backup_sha256:sha(backup),artifact_sha256:artifact.sha256,historical_task:task.taskId,
  checks:['drained previous runtime','snapshot includes committed WAL data','historical task and artifact preserved after upgrade',
    'candidate can create and drain new work','matching backup restored with all runtimes stopped','previous runtime reads restored task and artifact',
    'both runtimes reject newer schema'],
  limitations:['Both selected runtimes use schema 3; automatic schema-repair snapshot and backup-failure paths are separately tested in store.test.ts.']},null,2));
console.log('upgrade and rollback rehearsal passed');
