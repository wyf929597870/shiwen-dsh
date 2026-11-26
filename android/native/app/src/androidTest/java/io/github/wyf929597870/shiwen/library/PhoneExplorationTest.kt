package io.github.wyf929597870.shiwen.library

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

/** Exploration tests for standalone and coordinated Room stores; every fixture uses an isolated synthetic database. */
@RunWith(AndroidJUnit4::class)
class PhoneExplorationTest {
    private fun withRepository(role:String, block: (LibraryRepository) -> Unit) {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val libraryId = UUID.randomUUID().toString()
        val registryFile = "exploration-fixture-registry-$libraryId.sqlite"
        val libraryFile = "exploration-fixture-library-$libraryId.sqlite"
        val registry = Room.databaseBuilder(context, LibraryRegistryDatabase::class.java, registryFile).build()
        val row = LibraryRegistryRow(libraryId, "Conflict fixture", UUID.randomUUID().toString(), libraryFile,
            role, "complete", UUID.randomUUID().toString(), UUID.randomUUID().toString(), 1,
            null, null, null, "0", null, 1, true, false, false, "{}")
        registry.dao().insert(row)
        val repo = LibraryRepository(context, libraryId, row.deviceId, row.name, registry, row)
        try { block(repo) }
        finally {
            repo.executor.shutdownNow(); repo.db.close(); registry.close()
            context.deleteDatabase(libraryFile); context.deleteDatabase(registryFile)
            java.io.File(context.filesDir, "libraries/$libraryId").deleteRecursively()
        }
    }


    @Test fun independentAndBoundPoolPreserveSourceIdentityAndResponseBody(){
        for(role in listOf("standalone","coordinated"))withRepository(role){ repo->
            val pool=PhoneExploration(repo)
            val record=freshId()
            val text="我想🙂再读一页。"
            val base=obj("kind" to "reading_note","id" to record,"markdown" to text,"origin" to "personal","title" to "阅读记录",
                "sources" to JSONArray().put(obj("text" to text,"origin" to "personal")),
                "annotation" to obj("schema" to "shiwen.reading-note.v1","excerpts" to JSONArray().put(obj("text" to text))).toString())
            repo.create(freshId(),base,0)
            val source=obj("recordId" to record,"revision" to repo.read(record).revision)
            fun suggest(key:String,cite:JSONObject):JSONObject{
                val item=obj("type" to "explore","text" to key,"externalItemId" to key,"sources" to JSONArray().put(cite))
                val request=obj("requestId" to freshId(),"expectedLibraryId" to repo.libraryId,"suggestions" to JSONArray().put(item))
                val submitted=pool.execute("shiwen_exploration_suggest",request)
                assertEquals(submitted.toString(),pool.execute("shiwen_exploration_suggest",request).toString())
                val retried=pool.execute("shiwen_exploration_suggest",JSONObject(request.toString()).put("requestId",freshId())).getJSONArray("items").getJSONObject(0)
                assertEquals("existing",retried.getString("status"))
                assertEquals(submitted.getJSONArray("items").getJSONObject(0).getString("questionId"),retried.getString("questionId"))
                return pool.detail(submitted.getJSONArray("items").getJSONObject(0).getString("questionId"))
            }
            val cases=listOf(JSONObject(source.toString()) to "来自这篇笔记",
                JSONObject(source.toString()).put("quote",text) to "来自这篇笔记",
                JSONObject(source.toString()).put("field","excerpt").put("quote",text).put("excerptIndex",0) to "书中原文",
                JSONObject(source.toString()).put("field","reflection").put("quote",text) to "我的原句")
            for((index,pair) in cases.withIndex()){
                val q=suggest("要继续探索吗 "+index,pair.first)
                val evidence=q.getJSONArray("sources").getJSONObject(0)
                assertEquals(pair.second,evidence.getString("label"))
                assertEquals(index==3,evidence.getBoolean("personal"))
                if(index!=3)continue
                val pin=q.getJSONObject("placements").getJSONObject("day")
                val accepted=pool.execute("shiwen_exploration_place",obj("expectedLibraryId" to repo.libraryId,
                    "requestId" to freshId(),"questionId" to q.getString("questionId"),"expectedRevision" to q.getInt("revision"),
                    "action" to "pin","period" to "day","periodKey" to pin.getString("key"),"expectedPlacementRevision" to pin.getInt("revision"),"accept" to true))
                val response=freshId()
                val request=obj("expectedLibraryId" to repo.libraryId,"requestId" to freshId(),"questionId" to q.getString("questionId"),
                    "expectedRevision" to accepted.getInt("revision"),"responseRecordId" to response,"body" to "  后来我读完了。\n")
                val saved=pool.execute("shiwen_exploration_respond",request)
                assertEquals(saved.toString(),PhoneExploration(repo).execute("shiwen_exploration_respond",request).toString())
                assertEquals("  后来我读完了。\n",repo.read(response).markdown)
                assertEquals(1,saved.getJSONArray("responses").length())
                if(pool.bound){
                    val intent=pool.get("outbox",request.getString("requestId"),area=pool.local)!!
                    assertEquals(response,intent.getString("dependency"))
                    assertFalse(intent.getJSONObject("operation").getJSONObject("args").has("body"))
                }
            }
        }
    }

    @Test fun relationCanArriveBeforeItsBody() {
        withRepository("coordinated") { repo ->
            val pool = PhoneExploration(repo)
            val source = repo.create(freshId(), obj("kind" to "idea", "markdown" to "我想知道后来的事。"), 0)
            val question = pool.suggestion(obj("type" to "explore", "externalItemId" to freshId(),
                "text" to "后来怎样了？", "sources" to JSONArray().put(obj("recordId" to source.id,
                    "revision" to source.revision))), "external").getString("questionId")
            val response = freshId()
            pool.put("exploration_responses", obj("question" to question, "record" to response), question, response)
            assertEquals(0, pool.detail(question).getJSONArray("responses").length())
            repo.create(freshId(), obj("id" to response, "kind" to "idea", "markdown" to "  我去看了。\n"), 0)
            val visible = PhoneExploration(repo).detail(question).getJSONArray("responses")
            assertEquals(1, visible.length())
            assertEquals(response, visible.getJSONObject(0).getString("recordId"))
            assertEquals("  我去看了。\n", repo.read(response).markdown)
        }
    }

    @Test fun reorderedSourcesAndBackgroundNearMatchKeepReviewedQuestion(){
        for(role in listOf("standalone","coordinated"))withRepository(role){repo->
            val pool=PhoneExploration(repo)
            fun source(text:String):JSONObject{
                val r=repo.create(freshId(),obj("kind" to "idea","markdown" to text,"origin" to "personal"),0)
                return obj("recordId" to r.id,"revision" to r.revision,"quote" to text)
            }
            val a=source("阅读让我平静");val b=source("我今天放下了手机")
            fun suggest(actor:String,text:String,vararg refs:JSONObject)=pool.suggestion(
                obj("type" to "explore","externalItemId" to freshId(),"text" to text,"sources" to JSONArray(refs.toList())),actor)
            val original="怎样继续阅读？"
            val first=suggest("external",original,a,b)
            val question=first.getString("questionId")
            pool.execute("shiwen_exploration_review",obj("action" to "rewrite","text" to "我的阅读计划","questionId" to question,"expectedRevision" to 1,"requestId" to freshId()))
            val again=suggest("external",original,b,a)
            assertEquals("existing",again.getString("status"));assertEquals(question,again.getString("questionId"))
            val q=pool.detail(question)
            assertEquals(2,q.getJSONArray("sources").length());assertEquals("我的阅读计划",q.getString("text"))
            val near=pool.detail(suggest("background","怎样继续阅读下去？",b).getString("questionId"))
            assertEquals("pending",near.getString("status"))
            val pair=near.getJSONArray("possibleDuplicates").getJSONObject(0)
            assertEquals(question,pair.getString("questionId"));assertEquals(b.getString("recordId"),pair.getJSONArray("recordIds").getString(0))
            assertEquals(0,pool.execute("shiwen_recommendation_list",obj("view" to "week")).getJSONArray("items").length())
        }
    }

    @Test fun incompatibleComputerPreservesPendingAndLastConfirmedCache(){
        withRepository("coordinated"){ repo->
            val pool=PhoneExploration(repo)
            pool.put("outbox",obj("state" to "sent","fingerprint" to "prior"),"waiting",area=pool.local)
            pool.put("sync",obj("lastSync" to 1700000000),"status",area=pool.local)
            val sync=ExplorationSync(repo){_,_->error("UNKNOWN_METHOD")}
            assertFalse(sync.connect())
            val status=pool.execute("explorationSyncStatus",obj())
            assertEquals("upgrade_required",status.getJSONObject("status").getString("state"))
            assertEquals(1700000000,status.getJSONObject("status").getLong("lastSync"))
            assertEquals("prior",status.getJSONArray("items").getJSONObject(0).getString("fingerprint"))
        }
    }

    @Test fun priorBatchCannotReviveHiddenCardsOrInvalidQuotations(){
        for(scenario in listOf("skip","single","partial"))withRepository("coordinated"){repo->
            val pool=PhoneExploration(repo)
            fun create(text:String):JSONObject {
                val record=repo.create(freshId(),obj("kind" to "idea","markdown" to text,"origin" to "personal"),0)
                repo.dao.updateRecord(record.copy(serverRevision=8,syncState="synced"))
                return obj("recordId" to record.id,"revision" to 8,"quote" to text)
            }
            val a=create("昨天我决定继续阅读。");val b=create("我还留着书签。")
            val refs=JSONArray().put(a);if(scenario=="partial")refs.put(b)
            val item=obj("externalItemId" to freshId(),"type" to "explore","text" to "后来我读完了吗？","sources" to refs)
            val id=pool.suggestion(item,"test").getString("questionId")
            pool.execute("shiwen_exploration_review",obj("action" to "accept","questionId" to id,"expectedRevision" to 1,"requestId" to freshId()))
            val saved=mutableMapOf<String,JSONObject>()
            for(p in listOf("week","day")){
                val q=pool.detail(id);val pos=q.getJSONObject("placements").getJSONObject(p);val key=pos.getString("key")
                pool.execute("shiwen_exploration_place",obj("action" to "pin","period" to p,"periodKey" to key,"expectedPlacementRevision" to pos.getInt("revision"),
                    "questionId" to id,"expectedRevision" to q.getInt("revision"),"requestId" to freshId()))
                saved[p]=pool.get("exploration_periods",p,key)!!
            }
            fun verify(){
                val feeds=listOf("week","daily").map {pool.execute("shiwen_recommendation_list",obj("view" to it)).getJSONArray("items")}
                for(feed in feeds){
                    assertEquals(if(scenario=="partial")1 else 0,feed.length())
                    if(scenario=="partial"){
                        val card=feed.getJSONObject(0)
                        assertEquals(id,card.getString("questionId"))
                        assertEquals(b.getString("recordId"),card.getJSONArray("quotes").getJSONObject(0).getString("recordId"))
                        assertEquals(1,card.getJSONArray("quotes").length())
                    }
                }
                val preview=pool.execute("shiwen_recommendation_read",obj("cardId" to id))
                assertEquals(scenario=="partial",preview.getBoolean("valid"))
                if(scenario!="skip")assertTrue(preview.getJSONArray("quotes").objects().none {it.getString("recordId")==a.getString("recordId")})
            }
            if(scenario=="skip")pool.execute("shiwen_exploration_review",obj("action" to "skip","questionId" to id,"expectedRevision" to pool.detail(id).getInt("revision"),"requestId" to freshId()))
            else pool.put("source_state",obj("id" to a.getString("recordId"),"revision" to 9,"deleted" to 1),a.getString("recordId"))
            verify()
            for((p,batch) in saved)pool.put("exploration_periods",batch,p,batch.getString("period_key"))
            verify()
        }
    }
}
