package io.github.wyf929597870.shiwen.library

import android.content.Context
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import io.github.wyf929597870.shiwen.MainActivity
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Run with -e explorationUi true on an isolated device. Keeps and restores the initial selection. */
class ExplorationWebViewTest {
    @Test fun historyRunsInWorkManagerAfterSwitchingLibrary(){
        assumeTrue(InstrumentationRegistry.getArguments().getString("explorationUi")=="true")
        val context=ApplicationProvider.getApplicationContext<Context>()
        val manager=LibraryManager(context)
        val previous=manager.active().libraryId
        try{
            val repo=manager.create("独立库后台整理验收")
            val pool=PhoneExploration(repo)
            val parent=repo.create(freshId(),obj("kind" to "idea","markdown" to "今晚我读了几页。","origin" to "personal","contentDay" to "2026-11-01"),0)
            repo.annotationCreate(parent.id,parent.versionId,null,"阅读批注","## 待探索\n- 明天要继续读吗？",freshId())
            val job=pool.execute("shiwen_exploration_import",obj("mode" to "history","requestId" to freshId())).getString("jobId")
            manager.select(previous)
            PhoneDiscoveryWorker.enqueue(context,repo.libraryId)
            val deadline=System.nanoTime()+60_000_000_000
            while(pool.get("jobs",job)?.optString("status")!="ready"){
                check(System.nanoTime()<deadline){pool.get("jobs",job).toString()};Thread.sleep(150)
            }
            val question=pool.rows("exploration_questions").single()
            check(question.getString("original")=="明天要继续读吗？" && question.getString("status")=="pending")
            check(pool.detail(question.getString("id")).getJSONArray("sources").getJSONObject(0).getString("recordId")==parent.id)
            val q=question.getString("id")
            pool.execute("shiwen_exploration_review",obj("questionId" to q,"expectedRevision" to question.getInt("revision"),
                "requestId" to freshId(),"action" to "rewrite","text" to "阅读被打断后怎么办？"))
            val newer=repo.create(freshId(),obj("kind" to "journal","contentDay" to "2026-11-02","origin" to "personal",
                "markdown" to "阅读被打断时，我记下了页码。"),0)
            val followup=pool.execute("shiwen_exploration_import",obj("mode" to "incremental","requestId" to freshId())).getString("jobId")
            PhoneDiscoveryWorker.enqueue(context,repo.libraryId)
            val end=System.nanoTime()+60_000_000_000
            while(pool.get("jobs",followup)?.optString("status")!="ready"){
                check(System.nanoTime()<end){pool.get("jobs",followup).toString()};Thread.sleep(150)
            }
            val detail=pool.detail(q)
            check(detail.getJSONArray("clues").objects().single().getString("recordId")==newer.id)
            check(detail.getJSONArray("responses").length()==0)

        } finally {manager.select(previous);manager.close()}
    }

    @Test fun boundHomeFiltersStaleBatchesInTheLivePage() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("explorationUi")=="true")
        val manager=LibraryManager(ApplicationProvider.getApplicationContext<Context>())
        val previous=manager.active().libraryId
        val library=freshId()
        manager.attachRemote(library,freshId(),freshId(),1,freshId(),freshId(),"探索页面验收")
        manager.update(manager.row(library).copy(integrity="complete"))
        val repo=manager.select(library)
        val pool=PhoneExploration(repo)
        val title="我的阅读计划"
        fun source(text:String):JSONObject{
            val r=repo.create(freshId(),obj("title" to text,"kind" to "idea","markdown" to text,"origin" to "personal"),0)
            repo.dao.updateRecord(r.copy(serverRevision=1,syncState="synced"))
            return obj("recordId" to r.id,"revision" to 1,"quote" to text)
        }
        try {
            val invalid=source("已经撤回的引文");val kept=source("我仍在读这本书")
            val q=pool.suggestion(obj("text" to title,"type" to "explore","externalItemId" to freshId(),"sources" to JSONArray().put(invalid).put(kept)),"fixture").getString("questionId")
            val batches=mutableMapOf<String,JSONObject>()
            for(p in listOf("day","week")){
                val current=pool.detail(q);val placement=current.getJSONObject("placements").getJSONObject(p)
                pool.execute("shiwen_exploration_place",obj("questionId" to q,"requestId" to freshId(),"action" to "pin","accept" to true,"period" to p,
                    "expectedRevision" to current.getInt("revision"),"periodKey" to placement.getString("key"),"expectedPlacementRevision" to placement.getInt("revision")))
                batches[p]=pool.get("exploration_periods",p,placement.getString("key"))!!
            }
            val question=pool.get("exploration_questions",q)!!
            fun restoreBatch(){for((p,b) in batches)pool.put("exploration_periods",b,p,b.getString("period_key"))}
            ActivityScenario.launch(MainActivity::class.java).use { ui->
                fun js(expr:String):String{
                    val latch=CountDownLatch(1);var value=""
                    ui.onActivity { it.bridge.webView.evaluateJavascript(expr){r->value=r;latch.countDown()} }
                    check(latch.await(8,TimeUnit.SECONDS))
                    return value
                }
                fun until(expr:String){
                    repeat(90){if(js(expr)=="true")return;Thread.sleep(100)}
                    error("Page condition: "+expr+"; body: "+js("document.body.innerText.slice(-1200)"))
                }
                fun refresh(){js("window.dispatchEvent(new Event('shiwen-library-updated'))")}
                val buttons="[...document.querySelectorAll('button')]"
                fun click(text:String){
                    val match="$buttons.find(b=>b.textContent.includes("+JSONObject.quote(text)+"))"
                    until("Boolean($match)");js("$match.click()")
                }
                fun checkPage(visible:Boolean,oldQuote:Boolean=false){
                    val expected=if(visible)1 else 0
                    until("document.querySelectorAll('.sw-daily-grid button').length=="+expected+" && document.querySelectorAll('.sw-rec-grid button').length=="+expected+" && !!document.querySelector('.sw-daily h2')")
                    if(visible){
                        until("document.querySelector('.sw-rec-grid button').innerText.includes('今日也在写')")
                        click("查看本周全部")
                        until("document.querySelector('dialog .sw-rec-card')?.innerText.includes('我的阅读计划')===true")
                        js("document.querySelector('dialog .sw-rec-card').click()")
                        until("document.querySelectorAll('dialog[open]').length==2 && document.querySelectorAll('dialog')[1].innerText.includes('我仍在读这本书')")
                        until("document.querySelectorAll('dialog')[1].innerText.includes('已经撤回的引文')=="+oldQuote)
                        js("document.querySelectorAll('dialog')[1].querySelector('button[aria-label=关闭]').click()")
                        until("document.querySelectorAll('dialog[open]').length==1")
                        js("document.querySelector('dialog button[aria-label=关闭]').click()")
                    }else{
                        until("!document.body.innerText.includes('我的阅读计划')")
                    }
                }
                checkPage(true,true)
                val pending = pool.rows("outbox",pool.local).map { it.getString("fingerprint") }
                check(!ExplorationSync(repo){_,_->error("UNKNOWN_METHOD")}.connect())
                until("document.body.innerText.includes('探索同步需升级电脑')")
                checkPage(true,true)
                check(!ExplorationSync(repo){_,_->throw java.net.SocketTimeoutException("timeout")}.connect())
                until("document.body.innerText.includes('暂时无法连接电脑') && !document.body.innerText.includes('探索同步需升级电脑')")
                checkPage(true,true)
                check(pending == pool.rows("outbox",pool.local).map { it.getString("fingerprint") })
                pool.put("source_state",obj("id" to invalid.getString("recordId"),"revision" to 2,"deleted" to 1),invalid.getString("recordId"))
                refresh();checkPage(true)
                restoreBatch();refresh();checkPage(true)
                pool.put("source_state",obj("id" to kept.getString("recordId"),"revision" to 2,"deleted" to 1),kept.getString("recordId"))
                refresh();checkPage(false)
                restoreBatch();refresh();checkPage(false)
                // An independent status change also withdraws both placements with readable evidence.
                pool.drop("source_state",kept.getString("recordId"));refresh();checkPage(true)
                pool.put("exploration_questions",question.put("status","skipped").put("revision",question.getInt("revision")+1),q)
                refresh();checkPage(false)
                restoreBatch();refresh();checkPage(false)
            }
        } finally {manager.select(previous);manager.close()}
    }
}
