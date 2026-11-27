import {validateTopicBackup} from './store.mjs';
import {fingerprint} from '../sync/canonical.mjs';

const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
function identifier(id) {
  if (typeof id !== 'string' || !uuid.test(id)) throw Error('INVALID_TOPIC_ID');
  return id;
}

function wireMember(m) {
  return {id:m.id, sourceRecordId:m.source_record_id, sourceLibraryId:m.source_library_id,
    sourceTitle:m.source_title, sourceKind:m.source_kind, field:m.field, excerptIndex:m.excerpt_index,
    whole:!!m.whole, quote:m.quote, prefix:m.prefix, suffix:m.suffix, start:m.start, end:m.end,
    sourceRevision:m.source_revision, created:m.created, sourceBlocked:!!m.source_blocked};
}

function memberRow(m, themeId, libraryId, now) {
  if (typeof m.whole !== 'boolean') throw Error('INVALID_TOPIC_MEMBER');
  return {id:identifier(m.id), theme_id:themeId, source_record_id:m.sourceRecordId,
    source_library_id:m.sourceLibraryId, source_title:m.sourceTitle, source_kind:m.sourceKind,
    field:m.field, excerpt_index:m.excerptIndex ?? null, whole:Number(m.whole), quote:m.quote,
    prefix:m.prefix ?? '', suffix:m.suffix ?? '', start:m.start, end:m.end,
    source_revision:m.sourceRevision, created:m.created ?? now,
    source_blocked:Number(m.sourceBlocked === true || m.sourceLibraryId !== libraryId)};
}

// The desktop UI, MCP and sync all use the same themes and immutable passage rows.
export function createTopicSync(db) {
  db.exec('CREATE TABLE IF NOT EXISTS topic_sync_receipts(epoch TEXT, device TEXT, operation TEXT, digest TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(epoch,device,operation))');
  db.exec(`CREATE TABLE IF NOT EXISTS topic_sync_heads(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,deleted INTEGER NOT NULL,
    updated TEXT NOT NULL,title_updated TEXT NOT NULL,summary_updated TEXT NOT NULL);
    INSERT OR IGNORE INTO topic_sync_heads SELECT id,revision,0,updated,updated,updated FROM themes;
    CREATE TRIGGER IF NOT EXISTS topic_head_insert AFTER INSERT ON themes BEGIN
      INSERT INTO topic_sync_heads VALUES(NEW.id,1,0,NEW.updated,NEW.updated,NEW.updated)
      ON CONFLICT(id) DO UPDATE SET revision=revision+1,deleted=0,updated=NEW.updated,title_updated=NEW.updated,summary_updated=NEW.updated;
    END;
    CREATE TRIGGER IF NOT EXISTS topic_head_update AFTER UPDATE ON themes BEGIN
      UPDATE topic_sync_heads SET revision=revision+1,updated=NEW.updated,
        title_updated=CASE WHEN NEW.title<>OLD.title THEN NEW.updated ELSE title_updated END,
        summary_updated=CASE WHEN NEW.summary<>OLD.summary THEN NEW.updated ELSE summary_updated END WHERE id=NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS topic_head_delete AFTER DELETE ON themes BEGIN
      UPDATE topic_sync_heads SET revision=revision+1,deleted=1,updated=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=OLD.id;
    END;`);
  const clock = db.prepare('SELECT * FROM topic_sync_heads WHERE id=?');
  const head = db.prepare('SELECT * FROM themes WHERE id=?');
  const page = db.prepare('SELECT * FROM theme_members WHERE theme_id=? AND id>? ORDER BY id LIMIT 16');
  const receipt = db.prepare('SELECT digest,revision FROM topic_sync_receipts WHERE epoch=? AND device=? AND operation=?');

  return {
    heads({after=''}) {
      const heads = db.prepare('SELECT id,revision FROM topic_sync_heads WHERE id>? ORDER BY id LIMIT 500').all(after);
      return {heads,next:heads.length===500 ? heads.at(-1).id : null};
    },
    page: db.transaction(({id,revision,after=''}) => {
      const theme = head.get(identifier(id));
      const state = clock.get(id);
      if ((state?.revision ?? 0) !== revision) return {stale:true,revision:state?.revision ?? 0};
      if (!theme) return {deleted:true,updated:state?.updated ?? null,revision};
      Object.assign(theme,{revision,updated:state.updated,titleUpdated:state.title_updated,summaryUpdated:state.summary_updated});
      const rows = page.all(id,after);
      const members = [];
      let size = 0;
      for (const row of rows) {
        const m = wireMember(row);
        const bytes = Buffer.byteLength(JSON.stringify(m));
        if (members.length && size + bytes > 256 * 1024) break;
        members.push(m);
        size += bytes;
      }
      return {theme, members, next:members.length === rows.length && rows.length < 16 ? null : members.at(-1).id};
    }),
    apply: db.transaction(({epoch,deviceId,libraryId}, op) => {
      const id = identifier(op.id), key = [epoch,deviceId,identifier(op.operationId)], digest = fingerprint(op);
      const prior = receipt.get(...key);
      if (prior) {
        if (prior.digest !== digest) throw Error('OPERATION_REUSED');
        return {revision:prior.revision};
      }
      const old = head.get(id);
      const state = clock.get(id);
      if ((state?.revision ?? 0) !== op.expectedRevision) return {stale:true,revision:state?.revision ?? 0};
      const timestamp = value => {
        if (typeof value!=='string' || !Number.isFinite(Date.parse(value))) throw Error('INVALID_TOPIC_TIMESTAMP');
        return new Date(value).toISOString();
      };
      const now = timestamp(op.updated);
      let revision = 0;
      if (op.deleted === true) {
        if (old) {
          db.prepare('DELETE FROM themes WHERE id=?').run(id);
          db.prepare('UPDATE topic_sync_heads SET updated=? WHERE id=?').run(now,id);
        }
      } else {
        revision = (old?.revision ?? 0) + 1;
        const theme = {id,title:op.title,summary:op.summary,revision,created:old?.created ?? now,updated:now};
        const adds = op.add.map(m=>memberRow(m,id,libraryId,now));
        validateTopicBackup([theme],adds);
        if (old) db.prepare('UPDATE themes SET title=?,summary=?,revision=?,updated=? WHERE id=?').run(theme.title,theme.summary,revision,now,id);
        else {
          if (db.prepare('SELECT COUNT(*) n FROM themes').get().n >= 10000) throw Error('TOPIC_LIMIT');
          db.prepare('INSERT INTO themes VALUES(?,?,?,?,?,?)').run(id,theme.title,theme.summary,revision,now,now);
        }
        db.prepare('UPDATE topic_sync_heads SET title_updated=?,summary_updated=? WHERE id=?')
          .run(timestamp(op.titleUpdated),timestamp(op.summaryUpdated),id);
        const remove = db.prepare('DELETE FROM theme_members WHERE theme_id=? AND id=?');
        for (const memberId of op.remove) remove.run(id,identifier(memberId));
        const insert = db.prepare('INSERT INTO theme_members (id,theme_id,source_record_id,source_library_id,source_title,source_kind,field,excerpt_index,whole,quote,prefix,suffix,start,end,source_revision,created,source_blocked) VALUES ($id,$theme_id,$source_record_id,$source_library_id,$source_title,$source_kind,$field,$excerpt_index,$whole,$quote,$prefix,$suffix,$start,$end,$source_revision,$created,$source_blocked)');
        for (const m of adds) insert.run(m);
        if (db.prepare('SELECT COUNT(*) n FROM theme_members WHERE theme_id=?').get(id).n > 10000) throw Error('TOPIC_MEMBER_LIMIT');
      }
      revision = clock.get(id)?.revision ?? 0;
      db.prepare('INSERT INTO topic_sync_receipts VALUES(?,?,?,?,?)').run(...key,digest,revision);
      return {revision};
    })
  };
}
