import {DatabaseSync} from 'node:sqlite';
// SQLite runs only in the data utility process. Keep one writer and explicit
// transactions; no native addon needs a second Electron-specific ABI build.
export default class Database {
  constructor(path){this.connection=new DatabaseSync(path);this.depth=0;this.sequence=0;}
  exec(sql){return this.connection.exec(sql);}
  prepare(sql){return this.connection.prepare(sql);}
  pragma(statement){return this.connection.exec(`PRAGMA ${statement}`);}
  transaction(fn){return (...args)=>{
    const nested=this.depth>0,point=`shiwen_${++this.sequence}`;
    this.connection.exec(nested?`SAVEPOINT ${point}`:'BEGIN IMMEDIATE');this.depth++;
    try{const value=fn(...args);this.connection.exec(nested?`RELEASE ${point}`:'COMMIT');return value;}
    catch(error){this.connection.exec(nested?`ROLLBACK TO ${point}`:'ROLLBACK');if(nested)this.connection.exec(`RELEASE ${point}`);throw error;}
    finally{this.depth--;}
  };}
  close(){this.connection.close();}
}
