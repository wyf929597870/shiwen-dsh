package io.github.wyf929597870.shiwen.network

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

/** Real DSH Host smoke test. The Node script supplies an isolated Host and adb reverse port. */
@RunWith(AndroidJUnit4::class)
class NodeRealHostTest {
    @Test fun passwordLoginProfileAndReadOnlyManagementApisReachRealHost() {
        val arguments = InstrumentationRegistry.getArguments()
        val host = arguments.getString("syntheticHost")?.trim()?.trimEnd('/')
        val password = arguments.getString("syntheticPassword")
        assumeTrue("Run only with the synthetic Host fixture", !host.isNullOrBlank() && !password.isNullOrBlank())
        requireNotNull(host)
        requireNotNull(password)
        val uri = java.net.URI(host)
        require(uri.scheme == "http" && uri.host == "127.0.0.1" && uri.port in 1..65535 && uri.rawPath in listOf("", "/") && uri.rawQuery == null)

        val context = ApplicationProvider.getApplicationContext<Context>()
        val store = NodeSettingsStore(context, "node-real-host-${UUID.randomUUID()}")
        try {
            val id = store.save(null, "synthetic DSH Host", host, allowPrivateHttp = true).getString("id")
            NodeConnection(store).refresh(id, password)
            val profile = store.get(id).optJSONObject("profile") ?: error("PROFILE_NOT_SYNCED")
            assertEquals("shiwen", profile.getString("agentId"))
            assertTrue(profile.getString("systemContext").isNotBlank())
            assertTrue(profile.getString("revision").matches(Regex("[a-f0-9]{64}")))

            val management = NodeManagementActions(NodeConnection(store))
            val capabilities = management.manage(id, "capabilities", JSONObject()).getJSONObject("data")
            val supported = capabilities.optJSONArray("supportedActions") ?: error("CAPABILITIES_INVALID")
            assertTrue((0 until supported.length()).map(supported::getString).contains("plugins.listBundles"))
            assertTrue((0 until supported.length()).map(supported::getString).contains("schedules.list"))

            val bundles = management.manage(id, "plugins.listBundles", JSONObject()).get("data") as? JSONArray
                ?: error("PLUGIN_BUNDLES_INVALID")
            assertTrue("Expected at least one installed DSH bundle", bundles.length() > 0)
            for (index in 0 until bundles.length()) assertTrue(bundles.opt(index) is JSONObject)
            val scheduleList = management.manage(id, "schedules.list", JSONObject()
                .put("request", JSONObject().put("limit", 10).put("offset", 0))).getJSONObject("data")
            assertNotNull(scheduleList.optJSONArray("items"))

            val external = management.externalStatus(id)
            assertTrue(external.getBoolean("running"))
            assertNotNull(external.optJSONArray("clients"))
            assertFalse(external.has("root"))
            assertFalse(external.toString().contains("token_hash"))
        } finally {
            store.clearForTest()
        }
    }
}
