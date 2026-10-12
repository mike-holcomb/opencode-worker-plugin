// Non-inference environment evidence. Run from a checkout with runtime dependencies installed.
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { release, cpus } from 'node:os';
const args=process.argv.slice(2), index=args.indexOf('--out');
assert(index>=0 && args[index+1], 'Supply --out with a new evidence directory');
const out=resolve(args[index+1]);mkdirSync(out,{mode:0o700});
const runtime=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),plugin=dirname(runtime);
const wsl2=process.platform==='linux' && /microsoft-standard|microsoft.*wsl2/i.test(release());
assert(!args.includes('--require-wsl2')||wsl2, `Not a detected WSL2 kernel: ${release()}`);
assert(['24.15.0','24.21.0'].includes(process.versions.node), 'Use the campaign-pinned Node 24.15.0 or 24.21.0');
const env={...process.env,PATH:`${dirname(process.execPath)}:${process.env.PATH}`,PYTHONDONTWRITEBYTECODE:'1'};
const result={started_at:new Date().toISOString(),node:process.version,platform:process.platform,arch:process.arch,
  kernel:release(),wsl2,cpu:cpus()[0]?.model,revision:execFileSync('git',['rev-parse','HEAD'],{cwd:runtime,encoding:'utf8'}).trim(),
  diff_sha256:createHash('sha256').update(execFileSync('git',['diff','HEAD'],{cwd:runtime})).digest('hex'),
  checks:[],status:'running',limits:['No inference, managed live cases, or marketplace installation in this runner']};
writeFileSync(join(out,'source.diff'),execFileSync('git',['diff','HEAD'],{cwd:runtime}));
result.runner_sha256=createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
const persist=()=>writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2));persist();
function run(name,command,argv,cwd=runtime){const began=Date.now();const r=spawnSync(command,argv,{cwd,env,encoding:'utf8',timeout:300000,maxBuffer:20*1024*1024});
  writeFileSync(join(out,`${name}.stdout`),r.stdout??'');writeFileSync(join(out,`${name}.stderr`),r.stderr??'');
  result.checks.push({name,command,argv,exit_code:r.status,signal:r.signal,error:r.error?String(r.error):null,elapsed_ms:Date.now()-began});persist();
  console.log(`${name}: ${r.status===0?'passed':'failed'}`); assert.equal(r.status,0,`${name}: ${r.stderr??r.error}`);}
try{
 run('build','npm',['run','bundle']);
 run('runtime',process.execPath,['--test',...readdirSync(join(runtime,'dist/test')).filter(p=>p.endsWith('.test.js')).sort().map(p=>join(runtime,'dist/test',p))]);
 run('release-runner-tests',process.execPath,['--test',...readdirSync(join(runtime,'scripts/release')).filter(p=>p.endsWith('.test.mjs')).sort().map(p=>join(runtime,'scripts/release',p))]);
 run('packaging',process.execPath,['--test','tests/packaging.test.mjs'],plugin);
 run('evaluation-tests',process.execPath,['--test','evaluation/harness.test.mjs'],plugin);
 run('evaluation-fixtures',process.execPath,['evaluation/harness.mjs','validate'],plugin);
 run('inventory',process.execPath,['scripts/build_bundle.mjs','--check'],plugin);
 const zip=join(out,'opencode-agents.zip');
 run('archive',process.execPath,['scripts/build_bundle.mjs','--out',zip],plugin);
 run('installed-smoke',process.execPath,['scripts/smoke_installed_bundle.mjs',zip],plugin);
 result.status='passed';
}catch(error){result.status='failed';result.error=String(error);process.exitCode=1;}
finally{result.finished_at=new Date().toISOString();persist();}
