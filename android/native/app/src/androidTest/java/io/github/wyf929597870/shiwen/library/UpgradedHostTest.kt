package io.github.wyf929597870.shiwen.library

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import io.github.wyf929597870.shiwen.network.NodeConnection
import io.github.wyf929597870.shiwen.network.NodeSettingsStore
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test

class UpgradedHostTest {
    @Test fun restoresQueuedResponseAgainstSameUpgradedDesktop(){
        val args=InstrumentationRegistry.getArguments()
        assumeTrue(args.containsKey("upgradedLibrary"))
        val suffix=args.getString("registrySuffix")!!
        val library=args.getString("upgradedLibrary")!!
        val response=args.getString("queuedResponse")!!
        val context=ApplicationProvider.getApplicationContext<Context>()
        val nodes=NodeSettingsStore(context,"sync-host-node-$suffix")
        val manager=LibraryManager(context,"sync-host-registry-$suffix","sync-host-legacy-$suffix")
        val coordinator=LibrarySyncCoordinator(context,manager,nodes)
        try{
            val repo=manager.openLibrary(library)
            val pool=PhoneExploration(repo)
            val relation=pool.rows("outbox",pool.local).single {it.optString("dependency")==response}
            val question=relation.getJSONObject("operation").getJSONObject("args").getString("questionId")
            val node=JSONObject(repo.dao.meta("nodeBinding")!!).getString("nodeId")
            NodeConnection(nodes).refresh(node,args.getString("syntheticPassword")!!)
            repeat(2){
                val op=coordinator.syncNow(library,"manual").getString("operationId")
                val deadline=System.nanoTime()+45_000_000_000
                while(true){
                    val progress=coordinator.progress(library,op)
                    if(progress.optString("state")=="completed")break
                    check(progress.optString("state")!="failed" && System.nanoTime()<deadline){progress.toString()}
                    Thread.sleep(50)
                }
            }
            assertEquals("online",pool.execute("explorationSyncStatus",obj()).getJSONObject("status").getString("state"))
            assertTrue(pool.rows("outbox",pool.local).isEmpty())
            assertEquals("升级前保留的回应。",repo.read(response).markdown)
            val canonical = args.getString("desktopQuestion")!!
            assertNotEquals(question,canonical)
            val detail = pool.detail(question)
            assertEquals(canonical,detail.getString("questionId"))
            assertEquals("accepted",detail.getString("status"))
            assertEquals(response,detail.getJSONArray("responses").getJSONObject(0).getString("recordId"))
            assertEquals(1,pool.rows("exploration_questions").size)
        }finally{coordinator.closeForTest();manager.closeForTest();nodes.clearForTest()}
    }
}
