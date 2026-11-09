import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';

// Tickets are issued only by a separately authenticated local owner. This
// primitive does not expose a route or provide authentication by itself.
export function createPairingTickets({now=Date.now,ttlMs=120000,maxOutstanding=16,maxAttempts=5}={}){
 const tickets=new Map();
 const digest=value=>createHash('sha256').update(value).digest();
 const prune=()=>{const time=now();for(const [id,row] of tickets)if(row.expiresAt<=time)tickets.delete(id);};
 return {
  issue(){
   prune();if(tickets.size>=maxOutstanding)throw Error('PAIRING_LIMIT_REACHED');
   const id=randomBytes(16).toString('base64url'),secret=randomBytes(32).toString('base64url'),expiresAt=now()+ttlMs;
   tickets.set(id,{digest:digest(secret),expiresAt,attempts:0});return {id,secret,expiresAt};
  },
  consume(id,secret){
   prune();if(typeof id!=='string'||typeof secret!=='string'||id.length>128||secret.length>128)return false;
   const row=tickets.get(id);if(!row)return false;
   row.attempts++;
   const matched=timingSafeEqual(row.digest,digest(secret));
   if(matched||row.attempts>=maxAttempts)tickets.delete(id);
   return matched;
  },
  revokeAll(){tickets.clear();}
 };
}
