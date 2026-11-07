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
