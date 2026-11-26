package io.github.wyf929597870.shiwen.agent

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.security.KeyStore
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class ModelConfigStoreTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()

    private fun isolated(block: (String, ModelConfigStore) -> Unit) {
        val namespace = "model-config-test-${UUID.randomUUID()}"
        val store = ModelConfigStore(context, namespace)
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        try { block(namespace, store) }
        finally {
            context.getSharedPreferences(namespace, Context.MODE_PRIVATE).edit().clear().commit()
            keyStore.deleteEntry("$namespace-aes")
        }
    }

    @Test fun encryptedConfigurationSurvivesStoreReopenAndPublicProjectionOmitsSecret() = isolated { namespace, store ->
        val secret = "unit-secret-${UUID.randomUUID()}"
        val written = store.save("测试供应商", "https://models.example/v1/", "test-model", secret)

        val raw = context.getSharedPreferences(namespace, Context.MODE_PRIVATE).all.toString()
        assertFalse("The preference must contain only the encrypted envelope", raw.contains(secret))
        assertFalse(written.publicJson().toString().contains(secret))
        assertTrue(written.publicJson().getBoolean("configured"))
        assertTrue(KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.containsAlias("$namespace-aes"))

        val reopened = ModelConfigStore(context, namespace).read()
        assertNotNull(reopened)
        assertEquals("测试供应商", reopened!!.name)
        assertEquals("https://models.example/v1/", reopened.baseUrl)
        assertEquals("test-model", reopened.model)
        assertEquals(secret, reopened.apiKey)
        assertEquals(written.revision, reopened.revision)
    }

    @Test fun endpointChangeRequiresANewKeyAndSameEndpointCanKeepTheStoredKey() = isolated { _, store ->
        val secret = "local-test-${UUID.randomUUID()}"
        val first = store.save("Alpha", "https://alpha.example/v1", "model-a", secret)
        val same = store.save("Renamed", "https://alpha.example/v1/", "model-b", " ")
        assertEquals(secret, same.apiKey)
        assertNotEquals(first.revision, same.revision)
        assertTrue(runCatching { store.save("Beta", "https://beta.example/v1", "model-c", "") }.isFailure)
        assertEquals(secret, store.read()!!.apiKey)

        val newSecret = "replacement-test-${UUID.randomUUID()}"
        val changed = store.save("Beta", "https://beta.example/v1", "model-c", newSecret)
        assertEquals(newSecret, changed.apiKey)
        assertEquals("https://beta.example/v1/", changed.baseUrl)
    }

    @Test fun existingSingleModelEnvelopeKeepsRevisionAndKeyOnUpgrade() = isolated { namespace, store ->
        val old = store.save("旧模型", "https://model.example/v1", "legacy", "secret-legacy")
        val key = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.getKey("$namespace-aes", null)
        val cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(javax.crypto.Cipher.ENCRYPT_MODE, key)
            updateAAD(namespace.toByteArray())
        }
        fun encode(data: ByteArray) = android.util.Base64.encodeToString(data, android.util.Base64.NO_WRAP)
        val payload = old.publicJson().put("apiKey", old.apiKey).toString().toByteArray()
        val legacy = org.json.JSONObject().put("iv", encode(cipher.iv)).put("data", encode(cipher.doFinal(payload)))
        context.getSharedPreferences(namespace, Context.MODE_PRIVATE).edit().putString("encrypted",legacy.toString()).commit()
        val next = store.saveEntry(null, "新模型", "https://second.example/v1", "new", "new-key")
        assertEquals(old.revision, store.read()!!.revision)
        assertEquals("secret-legacy", store.get(old.revision).apiKey)
        assertEquals("new-key", store.get(next.revision).apiKey)
    }

    @Test fun multipleEndpointsKeepIndependentKeysAndDefaultSurvivesReopen() = isolated { namespace, store ->
        val a = store.save("A", "https://a.example/v1", "same-model", "secret-one")
        val b = store.saveEntry(null, "B", "https://b.example/v1", "same-model", "secret-two")
        assertEquals(a.revision, store.read()!!.revision)
        assertEquals(2, store.catalog().getJSONArray("models").length())
        assertFalse(store.catalog().toString().contains("secret-"))
        store.makeDefault(b.revision)
        val reopened = ModelConfigStore(context, namespace)
        assertEquals(b.revision, reopened.read()!!.revision)
        assertEquals("secret-one", reopened.get(a.revision).apiKey)
        val updated = reopened.saveEntry(a.revision, "A", a.baseUrl, "another", "")
        assertEquals("secret-one", updated.apiKey)
        assertEquals("secret-two", reopened.read()!!.apiKey)
        reopened.remove(b.revision)
        assertEquals(updated.revision, reopened.read()!!.revision)
    }

    @Test fun bulkSelectionIsAtomicAndKeepsExistingModelBindings() = isolated { _, store ->
        val url = "https://plan.example/v1/"
        val first = store.save("Plan", url, "first", "stored")
        val selected = store.saveModels(first.revision, "Plan", url, listOf("second", "first", "second"), "")
        assertEquals(listOf("second", "first"), selected.map { it.model })
        assertEquals(first.revision, store.read()!!.revision)
        val repeated = store.saveModels(null, "Plan", url, listOf("first", "second"), "stored")
        assertEquals(selected.map { it.revision }.toSet(), repeated.map { it.revision }.toSet())
        assertTrue(runCatching { store.saveModels(first.revision, "Plan", url, listOf("third", ""), "") }.isFailure)
        assertEquals(2, store.catalog().getJSONArray("models").length())
    }

    @Test fun invalidOrPlainHttpEndpointsAreRejectedBeforeSaving() = isolated { _, store ->
        for (url in listOf("http://model.example/v1", "https://u:p@model.example/v1", "https://model.example/v1?token=x", "not-a-url")) {
            assertTrue("Rejected URL: $url", runCatching { store.save("provider", url, "model", "key") }.isFailure)
        }
        assertNull(store.read())
    }

    @Test fun corruptedCiphertextFailsClosedAndExplicitClearDeletesTheKeystoreKey() = isolated { namespace, store ->
        store.save("provider", "https://model.example/v1", "model", "secret-test-${UUID.randomUUID()}")
        context.getSharedPreferences(namespace, Context.MODE_PRIVATE).edit()
            .putString("encrypted", "{\"iv\":\"AA==\",\"data\":\"AA==\"}").commit()

        val failure = runCatching { ModelConfigStore(context, namespace).read() }.exceptionOrNull()
        assertNotNull(failure)
        assertTrue(failure.toString(), failure.toString().contains("MODEL_CONFIG_UNAVAILABLE"))
        assertNull("Failed decryption must never return a partial/default credential", runCatching {
            ModelConfigStore(context, namespace).read()
        }.getOrNull())

        store.clear()
        assertNull(store.read())
        assertFalse(KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.containsAlias("$namespace-aes"))
        assertTrue(runCatching { store.save("provider", "https://model.example/v1", "model", "") }.isFailure)
    }
}
