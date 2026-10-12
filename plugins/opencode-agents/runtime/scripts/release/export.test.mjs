import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const script=fileURLToPath(new URL('./export.mjs',import.meta.url));
function setup(t) {
 const base=mkdtempSync(join(tmpdir(),'release-export-'));t.after(()=>rmSync(base,{recursive:true,force:true}));
 const source=join(base,'private'),dir=join(source,'case'),workspace=join(dir,'workspace');
 mkdirSync(workspace,{recursive:true});writeFileSync(join(dir,'packet.json'),'{}');
 writeFileSync(join(dir,'final.json'),JSON.stringify({workspace}));
 mkdirSync(join(dir,'state'));writeFileSync(join(dir,'state','config.json'),'private marker');
 return {base,source,dir,workspace,out:join(base,'portable')};
}
test('portable export verifies artifacts, copies fixtures and excludes private runtime state',t=>{
 const f=setup(t),bytes=Buffer.from('immutable report');writeFileSync(join(f.dir,'report.md'),bytes);
 writeFileSync(join(f.workspace,'input.txt'),'fixture');
 writeFileSync(join(f.dir,'exports.json'),JSON.stringify([{path:'report.md',sha256:createHash('sha256').update(bytes).digest('hex')}]));
 const r=spawnSync(process.execPath,[script,f.source,f.out],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 assert.equal(readFileSync(join(f.out,'case','report.md'),'utf8'),'immutable report');
 assert.equal(readFileSync(join(f.out,'case','workspace','input.txt'),'utf8'),'fixture');
 assert.equal(existsSync(join(f.out,'case','state')),false);
 const again=spawnSync(process.execPath,[script,f.source,f.out]);assert.notEqual(again.status,0);
});
test('portable export refuses artifact traversal, hash mismatch and fixture symlinks',t=>{
 const f=setup(t);writeFileSync(join(f.dir,'report.md'),'changed');
 writeFileSync(join(f.dir,'exports.json'),JSON.stringify([{path:'../state/config.json',sha256:'x'}]));
 assert.notEqual(spawnSync(process.execPath,[script,f.source,f.out]).status,0);
 writeFileSync(join(f.dir,'exports.json'),JSON.stringify([{path:'report.md',sha256:'x'}]));
 assert.notEqual(spawnSync(process.execPath,[script,f.source,join(f.base,'hash-out')]).status,0);
 writeFileSync(join(f.dir,'exports.json'),'[]');symlinkSync(join(f.dir,'state'),join(f.workspace,'linked'));
 assert.notEqual(spawnSync(process.execPath,[script,f.source,join(f.base,'link-out')]).status,0);
});
