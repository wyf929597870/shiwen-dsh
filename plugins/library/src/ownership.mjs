import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,realpathSync} from 'node:fs';
import {join} from 'node:path';

// A separate transaction owns the library without blocking its business database.
// OS locks disappear on crash. Never unlink this file: that would split the lock.
const leases=globalThis[Symbol.for('shiwen.library.leases')]??=new Map();
export function acquireOwnership(directory){
 mkdirSync(directory,{recursive:true,mode:0o700});
 const key=realpathSync(directory);
 let lease=leases.get(key);
 if(!lease){
  const db=new DatabaseSync(join(key,'.owner.sqlite'));
  try{db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');}
  catch(error){db.close();throw new Error('资料库正在被另一服务使用，请先退出桌面端或停止独立服务 / Library is already in use',{cause:error});}
  lease={db,refs:0};leases.set(key,lease);
 }
 lease.refs++;
 let released=false;
 return()=>{
  if(released)return;released=true;
  if(--lease.refs===0){lease.db.close();leases.delete(key);}
 };
}
