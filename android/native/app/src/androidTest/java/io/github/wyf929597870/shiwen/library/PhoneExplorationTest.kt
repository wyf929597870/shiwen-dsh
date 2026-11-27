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


    @Test fun nextStepKeepsItsBranchAndReturnsHomeOnTheReviewDay(){
        for(role in listOf("standalone","coordinated"))withRepository(role){ repo->
            val pool=PhoneExploration(repo)
            val record=repo.create(freshId(),obj("kind" to "idea","origin" to "personal","markdown" to "读书被打断。"),0)
            val q=pool.suggestion(obj("text" to "怎样接着读？","type" to "explore","externalItemId" to "q",
                "sources" to JSONArray().put(obj("recordId" to record.id,"revision" to 1))),"fixture").getString("questionId")
            fun write(method:String,args:JSONObject)=pool.execute("shiwen_exploration_"+method,args.put("requestId",freshId())
                .put("questionId",q).put("expectedRevision",pool.detail(q).getInt("revision")).put("expectedLibraryId",repo.libraryId))
            val response=freshId()
            write("respond",obj("responseRecordId" to response,"body" to "关火以后读了两页。"))
            fun add(id:String,kind:String,text:String,parent:String?=null,extra:JSONObject=obj()):JSONObject{
                extra.put("action","add").put("stepId",id).put("kind",kind).put("text",text)
                parent?.let {extra.put("parentId",it)}
                return write("step",extra)
            }
            if(pool.bound){
                assertTrue(runCatching {add("ask","ask","没协商就保存",extra=obj("accept" to true))}.isFailure)
                pool.put("sync",obj("enabled" to true),"stepCapability",area=pool.local)
            }
            add("ask","ask","为什么还能继续？",extra=obj("responseId" to response,"responseRevision" to 1,"quote" to "读了两页","accept" to true))
            fun daily()=PhoneExploration(repo).execute("shiwen_recommendation_list",obj("view" to "week")).getJSONArray("daily")
            assertEquals("ask",daily().getJSONObject(0).getJSONObject("nextStep").getString("id"))
            add("thought","judgment","我还记得中断的位置。","ask")
            add("trial","trial","下次留张书签","thought",obj("reviewDay" to "2099-12-01","observation" to "回来能读几页？"))
            assertEquals(0,daily().length())
            add("result","result","读了三页。","trial",obj("takeaway" to "书签有帮助。"))
            val head=daily().getJSONObject(0)
            assertEquals("accepted",head.getString("status"));assertEquals("trial",head.getJSONObject("nextStep").getString("parentId"))
            assertTrue(runCatching {add("duplicate","result","又一个结果","trial")}.isFailure)
            write("step",obj("action" to "select","stepId" to "ask"))
            assertEquals(4,pool.detail(q).getJSONArray("steps").length())
            write("step",obj("action" to "pause","stepId" to "ask"));assertEquals(0,daily().length())
            if(pool.bound)assertEquals(6,pool.rows("outbox",pool.local).count {it.getJSONObject("operation").getString("method")=="shiwen_exploration_step"})
        }
    }

    @Test fun laterPassagesCanBeDismissedOrLinkedWithoutDuplicatingRecords() {
        withRepository("standalone") { repo ->
            val pool=PhoneExploration(repo)
            fun record(day:String,text:String)=repo.create(freshId(),obj("kind" to "idea","origin" to "personal","contentDay" to day,"markdown" to text),0)
            val original=record("2026-11-01","阅读时经常被打断。")
            val suggested=pool.suggestion(obj("text" to "阅读被打断后怎么办？","type" to "explore","externalItemId" to "question",
                "sources" to JSONArray().put(obj("recordId" to original.id,"revision" to original.revision,"quote" to "经常被打断"))),"fixture")
            val id=suggested.getString("questionId")
            fun write(method:String,args:JSONObject)=pool.execute("shiwen_exploration_"+method,args.put("requestId",freshId()).put("questionId",id)
                .put("expectedLibraryId",repo.libraryId).put("expectedRevision",pool.detail(id).getInt("revision")))
            write("review",obj("action" to "accept"))
            val first=write("respond",obj("responseRecordId" to freshId(),"body" to "关火以后又翻了两页书。")).getJSONArray("responses").getJSONObject(0)
            assertEquals("关火以后又翻了两页书。",first.getString("preview"))
            assertFalse(first.isNull("contentDay"))
            val next=record("2026-11-02","先写另一件事。\n阅读被打断时，我记下了页码。")
            val skip=record("2026-11-03","阅读被打断以后我去泡了茶。")
            pool.discoverFollowups(next);pool.discoverFollowups(skip)
            assertEquals(2,pool.detail(id).getJSONArray("clues").length())
            write("review",obj("action" to "dismiss_clue","recordId" to skip.id,"sourceRevision" to skip.revision))
            val clue=pool.detail(id).getJSONArray("clues").getJSONObject(0)
            assertEquals(next.id,clue.getString("recordId"))
            assertEquals("阅读被打断时，我记下了页码。",clue.getString("quote"))
            val locator=JSONObject(clue,arrayOf("recordId","revision","field","start","end","quote"))
            write("respond",obj("responseRecordId" to next.id,"sourceRevision" to next.revision,"passage" to locator))
            pool.discoverFollowups(skip)
            val result=PhoneExploration(repo).detail(id)
            assertEquals(0,result.getJSONArray("clues").length())
            assertEquals(2,result.getJSONArray("responses").length())
            assertEquals(clue.getString("quote"),result.getJSONArray("responses").getJSONObject(0).getString("preview"))
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
