package io.github.wyf929597870.shiwen.library

import android.content.Context
import android.os.Bundle
import androidx.test.platform.app.InstrumentationRegistry
import android.util.Base64
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.wyf929597870.shiwen.MainActivity
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Exercises the real Capacitor bridge and WebView with a locally available image. */
@RunWith(AndroidJUnit4::class)
class MarkdownImageDisplayTest {
    @Test(timeout = 90_000) fun syncedStyleImageInsideLongHeadingRendersInRecord() {
        fun stage(name: String) = InstrumentationRegistry.getInstrumentation().sendStatus(0, Bundle().apply { putString("stage", name) })
        stage("setup")
        val context = ApplicationProvider.getApplicationContext<Context>()
        val manager = LibraryManager(context)
        val repo = manager.active()
        val bytes = Base64.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aWQAAAAASUVORK5CYII=", Base64.DEFAULT)
        val row = repo.importMarkdown(UUID.randomUUID().toString(), "Image bridge fixture 2", "seed", originalName = "fixture.png", originalBytes = bytes)
        val attachmentId = JSONArray(row.attachmentDescriptorsJson).getJSONObject(0).getString("id")
        val markdown = "Synthetic paragraph.\n\n".repeat(800) + "## **Synthetic heading ![image](attachment:$attachmentId)**\n"
        repo.update(row.id, row.revision, UUID.randomUUID().toString(), JSONObject().put("markdown", markdown))

        stage("launch")
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            stage("launched")
            fun evaluate(expression: String): String {
                val latch = CountDownLatch(1)
                var value = ""
                scenario.onActivity { activity ->
                    activity.bridge.webView.evaluateJavascript(expression) { result -> value = result; latch.countDown() }
                }
                check(latch.await(10, TimeUnit.SECONDS)) { "WEBVIEW_EVALUATION_TIMEOUT" }
                return value
            }
            fun waitUntil(expression: String) {
                repeat(100) { if (evaluate(expression) == "true") return; Thread.sleep(100) }
                error("WEBVIEW_CONDITION_TIMEOUT: $expression; details=" + evaluate("JSON.stringify([...document.querySelectorAll('.markdown-view')].map(x=>({images:[...x.querySelectorAll('img')].map(i=>({src:i.src.slice(0,80),complete:i.complete,width:i.naturalWidth})),end:x.innerHTML.slice(-600)})))"))
            }
            stage("navigation")
            waitUntil("Boolean(document.querySelector('nav button:nth-child(2)') && !document.querySelector('.library-trigger')?.disabled)")
            evaluate("document.querySelector('nav button:nth-child(2)').click(); true")
            waitUntil("Boolean([...document.querySelectorAll('.record-list-row')].find(x=>x.textContent.includes('Image bridge fixture 2')))")
            evaluate("[...document.querySelectorAll('.record-list-row')].find(x=>x.textContent.includes('Image bridge fixture 2')).click(); true")
            stage("image")
            waitUntil("Boolean(document.querySelector('.record-detail > .markdown-view img'))")
            evaluate("document.querySelector('.record-detail > .markdown-view img').scrollIntoView(); true")
            waitUntil("Boolean(document.querySelector('.record-detail > .markdown-view img')?.naturalWidth)")
            evaluate("document.querySelector('.record-versions > summary').click(); true")
            waitUntil("Boolean(document.querySelector('.version-row'))")
            waitUntil("Boolean(document.querySelector('.record-detail > .markdown-view img')?.naturalWidth)")
            assertEquals("true", evaluate("Boolean(document.querySelector('.record-detail > .markdown-view img')?.src.startsWith('data:image/png;base64,'))"))
        }
    }
}
