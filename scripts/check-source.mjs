// Checks the prospective Git source set. Reports paths/rules, never secret values.
import {execFileSync} from 'node:child_process';
import {readFileSync,lstatSync} from 'node:fs';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const files=[...new Set(execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean))];
const issues=[];
const deny=/(^|\/)(node_modules|upstream|release|\.runtime|backups|workspaces|\.dsh|\.codex|\.aws)(\/|$)|^plugins\/[^/]+\/lib\/|\.(sqlite[^/]*|db|log|pem|key)$|(^|\/)\.env($|\.(?!example$))/;
const rules=[
 ['private absolute home path',/\/(?:home\/wyf|Users\/[^/\s]+)\//],
 ['private key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
 ['GitHub token',/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
 ['Shiwen access token',/\bsw_[A-Za-z0-9_-]{43}\b/],
 ['provider key',/\bsk-[A-Za-z0-9_-]{24,}\b/],
];
for(const file of files){
 if(deny.test(file)){issues.push(`${file}: runtime/private/generated file`);continue;}
 const path=join(root,file),stat=lstatSync(path);
 if(!stat.isFile()){issues.push(`${file}: non-regular source file`);continue;}
 if(stat.size>5*1024*1024){issues.push(`${file}: larger than 5 MiB; review before publishing`);continue;}
 if(/\.(png|jpe?g|webp|ico|woff2?)$/.test(file))continue;
 const text=readFileSync(path,'utf8');
 for(const [label,pattern] of rules)if(pattern.test(text))issues.push(`${file}: ${label}`);
}
if(issues.length){console.error(issues.join('\n'));process.exitCode=1;}
else console.log(`Source audit passed: ${files.length} files; generated files, data paths and common credential patterns checked.`);
