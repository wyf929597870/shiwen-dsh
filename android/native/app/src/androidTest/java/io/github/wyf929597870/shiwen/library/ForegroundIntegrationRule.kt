package io.github.wyf929597870.shiwen.library

import android.app.Activity
import android.content.Intent
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.rules.ExternalResource

/** Opt-in foreground execution prevents OEM background freezing without changing device settings. */
class ForegroundIntegrationRule : ExternalResource() {
    private var activity: Activity? = null
    override fun before() {
        if (InstrumentationRegistry.getArguments().getString("foregroundTest") != "true") return
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        activity = instrumentation.startActivitySync(Intent().setClassName(instrumentation.targetContext,
            "io.github.wyf929597870.shiwen.testing.IntegrationTestActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        instrumentation.waitForIdleSync()
    }
    override fun after() {
        val current = activity ?: return
        InstrumentationRegistry.getInstrumentation().runOnMainSync { current.finish() }
        activity = null
    }
}
