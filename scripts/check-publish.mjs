import {execFileSync} from 'node:child_process';
import {readFileSync,statSync} from 'node:fs';
const files=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
if(!files.length) throw new Error('No tracked files: git add the public source before checking.');
const bad=[];
for(const f of files){
 if(/(^|\/)(node_modules|bots|logs|server_data|\.env)(\/|$)/.test(f)||/(^|\/)(keys\.json|andy\.json|\.env\..+)$/.test(f))bad.push(f+': private/runtime path');
 if(statSync(f).size>50*1024*1024)bad.push(f+': larger than 50 MiB');
 const text=readFileSync(f).toString('utf8');
 if(/sk-[A-Za-z0-9_-]{24,}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/.test(text))bad.push(f+': possible credential');
}
if(bad.length){console.error(bad.join('\n'));process.exitCode=1;}
else console.log(`PASS: ${files.length} tracked files; no forbidden runtime paths or obvious credentials detected.`);
