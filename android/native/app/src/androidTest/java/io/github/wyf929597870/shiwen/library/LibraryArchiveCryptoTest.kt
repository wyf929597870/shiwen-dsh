package io.github.wyf929597870.shiwen.library

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.security.MessageDigest

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

    @Test fun fileEncryptionStreamsArchivesLargerThanTwentyMiB() {
        val plain = File.createTempFile("shiwen-large-archive-", ".zip")
        val encrypted = File.createTempFile("shiwen-large-archive-", ".shiwen")
        val restored = File.createTempFile("shiwen-large-archive-", ".restored")
        try {
            val block = ByteArray(256 * 1024) { (it * 31).toByte() }
            FileOutputStream(plain).use { output -> repeat(100) { output.write(block) } }
            val expected = digest(plain)
            LibraryArchiveCrypto.encryptFile(plain, encrypted, "large backup password".toCharArray(), 64L * 1024 * 1024)
            assertTrue(LibraryArchiveCrypto.isEncrypted(encrypted))
            LibraryArchiveCrypto.decryptFile(encrypted, restored, "large backup password".toCharArray(), 64L * 1024 * 1024)
            assertEquals(plain.length(), restored.length())
            assertEquals(expected, digest(restored))
        } finally { plain.delete(); encrypted.delete(); restored.delete() }
    }

    private fun digest(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) { val count = input.read(buffer); if (count < 0) break; digest.update(buffer, 0, count) }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}
