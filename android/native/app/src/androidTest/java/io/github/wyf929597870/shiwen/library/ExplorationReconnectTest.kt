package io.github.wyf929597870.shiwen.library

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.net.HttpURLConnection
import java.net.URL

/** Each phase is launched in a fresh process by scripts/check-android-exploration.mjs. */
@RunWith(AndroidJUnit4::class)
class ExplorationReconnectTest {
    @Test fun resumePersistedOperations() {
        val args=InstrumentationRegistry.getArguments()
        assumeTrue(args.containsKey("explorationPort"))
        fun arg(key:String)=requireNotNull(args.getString(key))
        val phase=arg("phase");val deleted=arg("choice")=="deleted"
        val port=arg("explorationPort").toInt()
        val library=arg("library")
        val device=arg("device")
        val source=arg("source")
        val old=arg("question")
        val target=arg("target")
        val response=arg("response")
        val context=ApplicationProvider.getApplicationContext<Context>()
        val regFile="v6-test-registry-"+device+".sqlite"
        val realPage=args.getString("explorationUi")=="true"
        val libFile=if(realPage)"shiwen-library-$library.sqlite" else "v6-test-library-"+device+".sqlite"
        val registry=Room.databaseBuilder(context,LibraryRegistryDatabase::class.java,regFile).build()
        val row=LibraryRegistryRow(library,"v6 fixture",device,libFile,"coordinated","complete",arg("server"),arg("epoch"),1,
            null,null,null,"0",null,1,true,false,false,"{}")
        if(phase=="offline" || phase=="stepChain" && registry.dao().get(library)==null)registry.dao().insert(row)
        val repo=LibraryRepository(context,library,device,row.name,registry,row)
        fun remote(action:String,request:JSONObject):JSONObject {
            val http=URL("http://127.0.0.1:"+port+"/sync").openConnection() as HttpURLConnection
            return try{
                http.requestMethod="POST";http.connectTimeout=8000;http.readTimeout=12000;http.doOutput=true
                http.setRequestProperty("Authorization","Bearer "+arg("secret"))
                http.outputStream.use {it.write(obj("action" to action,"request" to request).toString().toByteArray())}
                val stream=if(http.responseCode==200)http.inputStream else http.errorStream
                val result=JSONObject(stream.bufferedReader().use {it.readText()})
                check(!result.has("error")){result.optString("error")}
                result
            }finally{http.disconnect()}
        }
        val pool=PhoneExploration(repo)
        val sync=ExplorationSync(repo){action,request->
            if(action=="explorationProof" && phase in listOf("unknownBody","unknownLink")){
                return@ExplorationSync JSONObject(request.toString()).put("status","unknown")
            }
            if(phase=="holdLink" && action=="explorationSubmit" && request.getJSONObject("operation").getString("method")=="shiwen_exploration_respond")
                error("Connection lost before relation reached host")
            val receipt=remote(action,request)
            if(phase=="loseLink" && action=="explorationSubmit" && request.optJSONObject("operation")?.optString("method")=="shiwen_exploration_respond")
                error("simulated lost relation response")
            receipt
        }
        fun call(method:String,args:JSONObject)=pool.execute(method,args.put("expectedLibraryId",library))
        val body="  我重新打开书，接着读了半页。\n"
        try{
            remote("identity",obj("protocolVersion" to "1.0.0-draft.3","deviceId" to device))
            assertTrue(sync.connect())
            when(phase){
                "offline"->{
                    repo.create(freshId(),obj("id" to source,"kind" to "idea","origin" to "personal","markdown" to "我把书签留在原地。"),0)
                    sync.sync(true)
                    val q=pool.detail(old)
                    val saved=call("shiwen_exploration_respond",obj("requestId" to freshId(),"questionId" to old,"expectedRevision" to q.getInt("revision"),"responseRecordId" to response,"body" to body))
                    if(!deleted)call("shiwen_exploration_review",obj("action" to "skip","questionId" to old,"expectedRevision" to saved.getInt("revision"),"requestId" to freshId()))
                    assertEquals(if(deleted)1 else 2,pool.rows("outbox",pool.local).size)
                }
                "holdBody"->{
                    val r=repo.dao.allOutbox().single {it.recordId==response}
                    assertNull(sync.beforeRecord(r))
                    repo.dao.updateOutbox(r.copy(attempts=1,state="unknown"))
                }
                "unknownBody"->{
                    val r=repo.dao.allOutbox().single {it.recordId==response}
                    assertEquals("unknown",sync.beforeRecord(r)?.getString("status"))
                    sync.sync(true)
                    assertEquals(body,repo.read(response).markdown)
                }
                "loseBody"->{
                    val r=repo.dao.allOutbox().single {it.recordId==response}
                    assertNull(sync.beforeRecord(r))
                    repo.dao.updateOutbox(r.copy(attempts=1,state="unknown"))
                    val requests=JSONArray().put(obj("inlineBody" to JSONObject(r.payloadJson)))
                    remote("push",obj("libraryId" to library,"epoch" to arg("epoch"),"deviceId" to device,"operations" to requests))
                    // Simulate losing the positive reply before Room could apply it.
                }
                "holdLink"->{
                    sync.sync(true)
                    val r=repo.dao.allOutbox().single {it.recordId==response}
                    assertEquals("applied",sync.beforeRecord(r)?.getString("status"))
                    repo.dao.updateOutbox(r.copy(state="applied"))
                    sync.sync()
                    assertEquals("sent",pool.rows("outbox",pool.local).single {it.has("dependency") && !it.isNull("dependency")}.getString("state"))
                }
                "unknownLink","loseLink"->{
                    sync.sync(true)
                    assertEquals("sent",pool.rows("outbox",pool.local).single {!it.isNull("dependency")}.getString("state"))
                }
                "resolve"->{
                    sync.sync(true);sync.sync()
                    assertEquals(body,repo.read(response).markdown)
                    assertEquals(if(deleted)0 else 1,pool.detail(target).getJSONArray("responses").length())
                    val blocked=pool.rows("outbox",pool.local).single()
                    assertEquals("conflict",blocked.getString("state"))
                    val q=pool.detail(target)
                    assertEquals("accepted",q.getString("status"))
                    if(deleted){
                        assertEquals("question_missing",blocked.getJSONObject("receipt").getString("code"))
                        val journal=repo.create(freshId(),obj("id" to arg("journal"),"kind" to "journal","contentDay" to "2024-06-09","markdown" to "另一篇日记也已送达。","origin" to "personal"),1)
                        val row=repo.dao.allOutbox().single {it.recordId==journal.id}
                        val sent=remote("push",obj("libraryId" to library,"epoch" to arg("epoch"),"deviceId" to device,"operations" to JSONArray().put(obj("inlineBody" to JSONObject(row.payloadJson)))))
                        assertEquals("applied",sent.getJSONArray("receipts").getJSONObject(0).getString("status"))
                    }
                    call("explorationConflictResolve",obj("operationId" to blocked.getString("id"),"conflictId" to blocked.getJSONObject("receipt").getString("conflictId"),
                        "choice" to (if(deleted)"abandon" else arg("choice")),"expectedTargetRevision" to q.getInt("revision")))
                    sync.sync()
                }
                "interopMerged" -> {
                    sync.sync()
                    assertEquals(arg("right"),pool.detail(arg("left")).getString("questionId"))
                }
                "interopDecisions" -> {
                    sync.sync()
                    val left = pool.detail(arg("left"))
                    val right = pool.detail(arg("right"))
                    assertEquals(arg("left"),left.getString("questionId"))
                    val placements = right.getJSONObject("placements")
                    assertTrue(placements.getJSONObject("day").getBoolean("pinned"))
                    assertFalse(placements.getJSONObject("week").getBoolean("pinned"))
                    val pair = left.getJSONArray("possibleDuplicates").objects().single { it.getString("questionId")==arg("right") }
                    call("shiwen_exploration_review",obj("requestId" to freshId(),"action" to "keep_separate",
                        "questionId" to arg("left"),"expectedRevision" to left.getInt("revision"),
                        "targetQuestionId" to arg("right"),"expectedTargetRevision" to right.getInt("revision"),
                        "evidenceFingerprint" to pair.getString("evidenceFingerprint")))
                    val review = call("shiwen_exploration_read",obj("reviewItemId" to arg("reviewId")))
                    call("shiwen_exploration_review",obj("requestId" to freshId(),"action" to "resolve_source",
                        "reviewItemId" to arg("reviewId"),"expectedReviewRevision" to review.getInt("revision"),
                        "mappings" to JSONArray().put(obj("externalSourceId" to "unmapped-source","recordId" to source,"revision" to 1))))
                    sync.sync()
                    assertTrue(pool.rows("outbox",pool.local).isEmpty())
                }
                "stepChain" -> {
                    if(repo.dao.record(source)==null){
                        val original=repo.create(freshId(),obj("id" to source,"kind" to "idea","origin" to "personal","markdown" to "我把书签留在原地。"),0)
                        repo.dao.updateRecord(original.copy(syncState="synced",serverRevision=1))
                    }
                    sync.sync(true)
                    val question=arg("stepQuestion")
                    val ask=pool.detail(question).getJSONObject("nextStep")
                    assertEquals("ask",ask.getString("kind"))
                    fun append(id:String,kind:String,text:String,parent:String){
                        call("shiwen_exploration_step",obj("requestId" to freshId(),"questionId" to question,
                            "expectedRevision" to pool.detail(question).getInt("revision"),"stepId" to id,"action" to "add",
                            "kind" to kind,"text" to text,"parentId" to parent))
                    }
                    val trial=freshId()
                    append(trial,"trial","离开前留张书签",ask.getString("id"))
                    append(freshId(),"result","我回来接着读了两页。",trial)
                    assertEquals(2,pool.rows("outbox",pool.local).size)
                    sync.sync(true);sync.sync(true)
                    assertTrue(pool.rows("outbox",pool.local).isEmpty())
                    val head=pool.detail(question)
                    assertEquals("result",head.getJSONObject("nextStep").getString("kind"))
                    assertEquals(trial,head.getJSONObject("nextStep").getString("parentId"))
                    assertEquals(3,head.getJSONArray("steps").length())
                }
                "interopFinal" -> {
                    // The ordinary channel supplies the same record before evaluating the exploration projection.
                    val note=repo.create(freshId(),obj("id" to arg("note"),"kind" to "reading_note","origin" to "personal",
                        "title" to "散步的笔记","markdown" to "我也想去看看。"),0)
                    repo.dao.updateRecord(note.copy(syncState="synced",serverRevision=1))
                    sync.sync(true)
                    val evidence=pool.detail(arg("mixed")).getJSONArray("sources").getJSONObject(0)
                    assertEquals("来自这篇笔记",evidence.getString("label"))
                    assertTrue(evidence.getBoolean("confirmed"))
                    assertEquals(source,pool.detail(arg("linked")).getJSONArray("sources").getJSONObject(0).getString("recordId"))
                    assertTrue(pool.detail(arg("left")).getJSONArray("possibleDuplicates").objects().none {it.getString("questionId")==arg("right")})
                    val weekly=call("shiwen_recommendation_list",obj("view" to "week"))
                    assertTrue(weekly.getJSONArray("items").objects().any {it.getString("questionId")==arg("mixed")})
                }
                "reopen"->{
                    sync.sync(true);sync.sync()
                    assertTrue(pool.rows("outbox",pool.local).isEmpty())
                    assertEquals(body,repo.read(response).markdown)
                    val q=pool.detail(target)
                    assertEquals(if(arg("choice")!="replace")"accepted" else "skipped",q.getString("status"))
                    if(!deleted)assertEquals(response,q.getJSONArray("responses").getJSONObject(0).getString("recordId"))
                    if(realPage){
                        val manager=LibraryManager(context)
                        val previous=manager.active().libraryId
                        try{
                            manager.attachRemote(library,arg("server"),arg("epoch"),1,freshId(),freshId(),"重连验收")
                            manager.update(manager.row(library).copy(integrity="complete",deviceId=device))
                            manager.select(library)
                            androidx.test.core.app.ActivityScenario.launch(io.github.wyf929597870.shiwen.MainActivity::class.java).use {ui->
                                var ready=false
                                val deadline=System.nanoTime()+18_000_000_000
                                while(!ready && System.nanoTime()<deadline){
                                    val latch=java.util.concurrent.CountDownLatch(1)
                                    ui.onActivity {it.bridge.webView.evaluateJavascript("Boolean(document.querySelector('.sw-daily h2') && document.body.innerText.includes('上次同步') && !document.body.innerText.includes('对应的问题已经变化'))"){v->ready=v=="true";latch.countDown()}}
                                    check(latch.await(3,java.util.concurrent.TimeUnit.SECONDS));Thread.sleep(100)
                                }
                                assertTrue("Cold-start conflict or unready bound page",ready)
                            }
                        }finally{manager.select(previous);manager.close()}
                    }
                }
            }
        }finally{
            repo.executor.shutdownNow();repo.db.close();registry.close()
            if(phase=="reopen"){context.deleteDatabase(libFile);context.deleteDatabase(regFile)}
        }
    }
}
