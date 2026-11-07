package io.github.wyf929597870.shiwen.network

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class NodeSettingsStoreTest {
    @Test fun encryptedNodesRestoreWithoutLeakingSecretsAndChangedAddressDropsCredentials() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val namespace = "node-test-${UUID.randomUUID()}"
        val store = NodeSettingsStore(context, namespace)
        try {
            val a = store.save(null, "电脑 A", "http://127.0.0.1:3091", true)
            val b = store.save(null, "电脑 B", "https://example.invalid", false)
            val id = a.getString("id"); val url = a.getString("baseUrl")
            store.update(id, url) { it.put("cookies", org.json.JSONArray().put("test-session=secret-value; Path=/"))
                .put("authenticated", true).put("profile", JSONObject().put("revision", "a".repeat(64))
                    .put("agentId", "shiwen").put("systemContext", "私人人设文本")) }
            store.select(id)
            assertFalse(store.list().toString().contains("secret-value"))
            assertFalse(store.list().toString().contains("私人人设文本"))
            val raw = context.getSharedPreferences(namespace, Context.MODE_PRIVATE).getString("encrypted", "")!!
            assertFalse(raw.contains("secret-value")); assertFalse(raw.contains("私人人设文本"))
            val restored = NodeSettingsStore(context, namespace)
            assertEquals("私人人设文本", restored.selectedProfile()!!.getString("systemContext"))
            assertEquals(id, restored.selectedProfile()!!.getString("nodeId"))
            NodeConnection.reserveRefresh(id).use {
                assertEquals("PROFILE_REFRESHING", runCatching { restored.selectedProfile() }.exceptionOrNull()?.message)
                assertTrue(restored.list().getJSONArray("items").getJSONObject(0).getBoolean("refreshing"))
            }
            assertNotNull(restored.selectedProfile())
            restored.select(b.getString("id"))
            assertEquals("PROFILE_NOT_SYNCED", runCatching { restored.selectedProfile() }.exceptionOrNull()?.message)
            restored.select(id)
            restored.save(id, "换了端口", "http://127.0.0.1:3092/", true)
            assertFalse(restored.get(id).getBoolean("authenticated"))
            assertFalse(restored.get(id).has("profile"))
            assertEquals(0, restored.get(id).getJSONArray("cookies").length())
            assertEquals("NODE_CHANGED", runCatching { restored.update(id, url) { it.put("profile", "late") } }.exceptionOrNull()?.message)
            restored.remove(id)
            assertNull(restored.selectedProfile()); assertEquals(1, restored.list().getJSONArray("items").length())
        } finally { store.clearForTest() }
    }
    @Test fun localModeAndProfileValidationFailClosed() {
        val store = NodeSettingsStore(ApplicationProvider.getApplicationContext(), "node-test-${UUID.randomUUID()}")
        try {
            assertNull(store.selectedProfile())
            assertTrue(runCatching { store.save(null, "x", "http://192.168.1.2/", false) }.isFailure)
            assertTrue(runCatching { store.save(null, "x", "https://example.invalid/?token=secret", false) }.isFailure)
            assertTrue(runCatching { NodeConnection.validateProfile(JSONObject().put("agentId", "unknown")) }.isFailure)
            store.select(null); assertNull(store.selectedProfile())
        } finally { store.clearForTest() }
    }
}
