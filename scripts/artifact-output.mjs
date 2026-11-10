import {mkdir,mkdtemp,lstat,cp,rename,rm,writeFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve,basename} from 'node:path';

export async function sha256(path){
 const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');
}
async function exists(path){try{return await lstat(path);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function directory(path){const info=await exists(path);if(info&&(!info.isDirectory()||info.isSymbolicLink()))throw Error('Artifact directory must be a real directory: '+path);await mkdir(path,{recursive:true});}

// Build separately; replace only this platform/channel after all files validate.
// A failed build never deletes the previous successful package.
export async function artifactOutput({root,platform,channel='release',args=[]}){
 if(!['release','debug'].includes(channel)||!['linux','windows','android','plugin'].includes(platform))throw Error('Invalid artifact target');
 const parent=join(resolve(root),channel),destination=join(parent,platform);
 const index=args.indexOf('--out-dir');
 if(args.some(x=>x.startsWith('--out-dir='))||(index>=0&&(!args[index+1]||resolve(args[index+1])!==destination)))throw Error('Packages must be written to '+destination+'; custom version/date directories are not allowed.');
 await directory(parent);
 const prior=await exists(destination);if(prior&&(!prior.isDirectory()||prior.isSymbolicLink()))throw Error('Unsafe artifact destination');
 const lock=join(parent,'.'+platform+'.lock');await mkdir(lock);
 let stage;
 try{stage=await mkdtemp(join(parent,'.'+platform+'-'));}catch(e){await rm(lock,{recursive:true});throw e;}
 let published=false;
 return {directory:stage,destination,
  async publish(paths,{unpacked=false}={}){
   if(published||!paths.length)throw Error('No new artifacts to publish');
   const ready=join(stage,'ready');await mkdir(ready);
   const names=new Set();
   for(const path of paths){
    const name=basename(path),info=await lstat(path);
    if(names.has(name)||info.isSymbolicLink()||(!info.isFile()&&!(unpacked&&info.isDirectory()))||info.isFile()&&!info.size)throw Error('Invalid artifact: '+path);
    names.add(name);await cp(path,join(ready,name),{recursive:info.isDirectory()});
    if(info.isFile()){
     const hash=await sha256(path);if(hash!==await sha256(join(ready,name)))throw Error('Artifact copy checksum mismatch');
     await writeFile(join(ready,name+'.sha256'),hash+'  '+name+'\n');
    }
   }
   const previous=join(stage,'previous');let moved=false;
   if(await exists(destination)){await rename(destination,previous);moved=true;}
   try{await rename(ready,destination);}catch(e){if(moved)await rename(previous,destination);throw e;}
   published=true;await rm(previous,{recursive:true,force:true});
   return paths.map(path=>join(destination,basename(path)));
  },
  async dispose(){await rm(stage,{recursive:true,force:true});await rm(lock,{recursive:true,force:true});}
 };
}
