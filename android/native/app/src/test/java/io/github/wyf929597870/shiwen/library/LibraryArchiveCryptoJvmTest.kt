package io.github.wyf929597870.shiwen.library

import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.nio.ByteBuffer
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

class LibraryArchiveCryptoJvmTest {
    @Test fun previousSingleTagEncryptedArchivesRemainReadable() {
        val secret = "legacy password long".toCharArray(); val salt = ByteArray(16) { it.toByte() }; val nonce = ByteArray(12) { (it + 5).toByte() }
        val spec = PBEKeySpec(secret, salt, 310000, 256)
        val key = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded; spec.clearPassword()
        val header = "SHWBKUP1".toByteArray() + byteArrayOf(1) + ByteBuffer.allocate(4).putInt(310000).array() + salt + nonce
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD("SHWBKUP1".toByteArray() + byteArrayOf(1) + ByteBuffer.allocate(4).putInt(310000).array())
        val data = "old backup".toByteArray(); val encrypted = header + cipher.doFinal(data);key.fill(0)
        assertArrayEquals(data, LibraryArchiveCrypto.decrypt(encrypted, secret))
    }

    @Test fun streamedBackupAuthenticatesLargeContentAndRejectsTruncation() {
        val dir = createTempDir(prefix = "shiwen-archive-crypto-")
        val plain = File(dir, "plain")
        val encrypted = File(dir, "encrypted")
        val restored = File(dir, "restored")
        try {
            val block = ByteArray(256 * 1024) { (it * 31).toByte() }
            FileOutputStream(plain).use { out -> repeat(100) { out.write(block) } }
            LibraryArchiveCrypto.encryptFile(plain, encrypted, "test password long".toCharArray(), 64L * 1024 * 1024)
            LibraryArchiveCrypto.decryptFile(encrypted, restored, "test password long".toCharArray(), 64L * 1024 * 1024)
            assertEquals(digest(plain), digest(restored))
            RandomAccessFile(encrypted, "rw").use { it.setLength(it.length() - 1) }
            assertThrows(Exception::class.java) { LibraryArchiveCrypto.decryptFile(encrypted, restored, "test password long".toCharArray(), 64L * 1024 * 1024) }
            assertFalse(restored.exists())
        } finally { dir.deleteRecursively() }
    }

    private fun digest(file: File): String {
        val hash = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { input -> val buffer = ByteArray(65536); while (true) { val n = input.read(buffer); if (n < 0) break; hash.update(buffer, 0, n) } }
        return hash.digest().joinToString("") { "%02x".format(it) }
    }
}
