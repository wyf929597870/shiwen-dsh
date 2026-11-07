package io.github.wyf929597870.shiwen.library

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test

class LibraryArchiveCryptoTest {
    @Test fun portableEncryptionRoundTripsAndRejectsWrongPasswordOrTampering() {
        val source = "complete backup contents".toByteArray()
        val encrypted = LibraryArchiveCrypto.encrypt(source, "correct horse battery".toCharArray())
        assertTrue(LibraryArchiveCrypto.isEncrypted(encrypted))
        assertArrayEquals(source, LibraryArchiveCrypto.decrypt(encrypted, "correct horse battery".toCharArray()))
        assertEquals("BACKUP_PASSWORD_INVALID", assertThrows(IllegalStateException::class.java) {
            LibraryArchiveCrypto.decrypt(encrypted, "not the right password".toCharArray())
        }.message)
        val tampered = encrypted.clone().also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() }
        assertThrows(IllegalStateException::class.java) { LibraryArchiveCrypto.decrypt(tampered, "correct horse battery".toCharArray()) }
        assertFalse(LibraryArchiveCrypto.isEncrypted(source))
    }

    @Test fun invalidKdfParametersAreRejectedBeforeDerivation() {
        val encrypted = LibraryArchiveCrypto.encrypt("zip".toByteArray(), "long enough password".toCharArray())
        // Header: 8-byte magic, one-byte version, then four-byte iteration count.
        val downgraded = encrypted.clone().also { bytes ->
            bytes[9] = 0; bytes[10] = 0; bytes[11] = 0; bytes[12] = 2
        }
        assertEquals("BACKUP_KDF_PARAMETERS_INVALID", assertThrows(IllegalStateException::class.java) {
            LibraryArchiveCrypto.decrypt(downgraded, "long enough password".toCharArray())
        }.message)
    }

    @Test fun shortPasswordsAreRejected() {
        assertEquals("BACKUP_PASSWORD_LENGTH_INVALID", assertThrows(IllegalArgumentException::class.java) {
            LibraryArchiveCrypto.encrypt(byteArrayOf(1), "short".toCharArray())
        }.message)
    }
}
