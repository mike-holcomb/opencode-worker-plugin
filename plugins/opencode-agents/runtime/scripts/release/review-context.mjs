// Capture exactly the files presented for parent review, including all fixture source.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const dir=resolve(process.argv[2]); const files=['packet.json','final.json','exports.json','summary.md'];
const exports=JSON.parse(readFileSync(join(dir,'exports.json')));
files.push(...exports.filter(a=>a.path!=='summary.md').map(a=>a.path));
function visit(path,prefix){for(const n of readdirSync(path).sort()){if(['.git','__pycache__','.pytest_cache'].includes(n))continue;
 const abs=join(path,n),rel=join(prefix,n),s=lstatSync(abs);assert(!s.isSymbolicLink(),'Review symlink separately');
 if(s.isDirectory())visit(abs,rel);else if(s.isFile())files.push(rel);}}
const workspace=JSON.parse(readFileSync(join(dir,'final.json'))).workspace;
visit(workspace,'workspace');
const location=f=>f.startsWith('workspace/')?join(workspace,f.slice(10)):join(dir,f);
let bytes=0; const records=[]; const sections=[];
for(const f of files){if(!existsSync(location(f))){sections.push(`\n--- ${f}: missing ---\n`);continue;}const data=readFileSync(location(f));bytes+=data.length;
 records.push({path:f,sha256:createHash('sha256').update(data).digest('hex'),bytes:data.length});
 sections.push(`\n--- ${f} ---\n${data.toString('utf8')}`);}
const record={review_started_at:new Date().toISOString(),context_bytes:bytes,files:records};
writeFileSync(join(dir,'review-context.json'),JSON.stringify(record,null,2));
console.log(sections.join(''));
