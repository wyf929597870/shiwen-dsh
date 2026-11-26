import {randomUUID} from 'node:crypto';
import Database from '../../plugins/library/legacy/sqlite.mjs';
import {passages} from '../../plugins/library/src/assist/evidence.mjs';

// A card actually persisted in the pre-exploration format. Old card actions
// must remain usable after the homepage switches to exploration questions.
export function insertLegacyCard(path,store,record){
 const db=new Database(path);
 try{
  const libraryId=store.themeContext().libraryId,week=store.assist.call('shiwen_recommendation_settings',{}).week;
  const quote=passages(store.get(record.id))[0],cardId=randomUUID();
  const card={week,cardId,cardRevision:1,question:'当时发生了什么？',scene:'writing',reason:'原推荐的出处',followup:'',
   quotes:[quote],relations:[{relationId:randomUUID(),quoteIds:[quote.quoteId],reason:'原推荐的出处',type:'writing'}],
   targets:{themes:[],drafts:[],decisions:[]},savedForLater:false};
  const put=db.prepare('INSERT INTO assist_data VALUES(?,?,?,?)');
  put.run(libraryId,'card',cardId,JSON.stringify(card));
  put.run(libraryId,'week',week,JSON.stringify({published:[cardId],opened:true,scanned:{}}));
  return card;
 }finally{db.close();}
}
