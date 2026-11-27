package io.github.wyf929597870.shiwen.library

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import java.io.FileInputStream
import java.nio.LongBuffer
import java.nio.channels.FileChannel
import java.text.Normalizer
import java.util.Locale
import kotlin.math.sqrt

/** BERT basic tokenizer and greedy WordPiece, using the vocabulary packaged with this export. */
internal class PhoneBgeEncoder private constructor(context: Context) {
    private val vocab = context.assets.open("bge/vocab.txt").bufferedReader().useLines { lines ->
        lines.withIndex().associate { (i, word) -> word to i.toLong() }
    }
    private val environment = OrtEnvironment.getEnvironment()
    private val model = context.assets.openFd("bge/model_quantized.onnx").use { descriptor ->
        FileInputStream(descriptor.fileDescriptor).channel.use { channel ->
            channel.map(FileChannel.MapMode.READ_ONLY, descriptor.startOffset, descriptor.declaredLength)
        }
    }
    private val session = OrtSession.SessionOptions().use { options ->
        options.setIntraOpNumThreads(2)
        options.setInterOpNumThreads(1)
        environment.createSession(model, options)
    }

    fun tokens(text: String): LongArray {
        val ids = mutableListOf(vocab.getValue("[CLS]"))
        val word = StringBuilder()
        fun flush() {
            if (word.isEmpty()) return
            val clean = Normalizer.normalize(word.toString().lowercase(Locale.ROOT), Normalizer.Form.NFD)
                .filter { Character.getType(it) != Character.NON_SPACING_MARK.toInt() }
            word.setLength(0)
            if (clean.isEmpty()) return
            val points = clean.codePoints().toArray()
            val pieces = mutableListOf<Long>()
            var start = 0
            while (points.size <= 100 && start < points.size) {
                var end = points.size
                var id: Long? = null
                while (end > start && id == null) {
                    val piece = String(points, start, end - start)
                    id = vocab[if (start == 0) piece else "##$piece"]
                    if (id == null) end--
                }
                if (id == null) break
                pieces.add(id)
                start = end
            }
            if (start == points.size) ids.addAll(pieces) else ids.add(vocab.getValue("[UNK]"))
        }
        text.codePoints().forEach { cp ->
            val type = Character.getType(cp)
            when {
                cp == 0 || cp == 0xfffd -> Unit
                Character.isWhitespace(cp) || Character.isSpaceChar(cp) -> flush()
                type == Character.CONTROL.toInt() || type == Character.FORMAT.toInt() -> Unit
                Character.UnicodeScript.of(cp) == Character.UnicodeScript.HAN ||
                    cp in 33..47 || cp in 58..64 || cp in 91..96 || cp in 123..126 ||
                    type in Character.DASH_PUNCTUATION.toInt()..Character.OTHER_PUNCTUATION.toInt() ||
                    type == Character.INITIAL_QUOTE_PUNCTUATION.toInt() || type == Character.FINAL_QUOTE_PUNCTUATION.toInt() -> {
                    flush(); word.appendCodePoint(cp); flush()
                }
                else -> word.appendCodePoint(cp)
            }
        }
        flush()
        ids.add(vocab.getValue("[SEP]"))
        return ids.toLongArray()
    }

    fun embed(text: String): FloatArray {
        val encoded = tokens(text)
        val ids = if (encoded.size <= 512) encoded else encoded.copyOf(512).also { it[511] = encoded.last() }
        val shape = longArrayOf(1, ids.size.toLong())
        val inputs = mutableMapOf<String, OnnxTensor>()
        try {
            for (name in session.inputNames) {
                val data = when (name) {
                    "input_ids" -> ids
                    "attention_mask" -> LongArray(ids.size) { 1L }
                    "token_type_ids" -> LongArray(ids.size)
                    else -> error("未知 BGE 输入 $name")
                }
                inputs[name] = OnnxTensor.createTensor(environment, LongBuffer.wrap(data), shape)
            }
            return session.run(inputs).use { result ->
                val hidden = result.get("last_hidden_state").get() as OnnxTensor
                val cls = FloatArray(768)
                hidden.floatBuffer.get(cls)
                val norm = sqrt(cls.sumOf { it.toDouble() * it }).toFloat()
                check(norm.isFinite() && norm > 0f)
                for (i in cls.indices) cls[i] /= norm
                cls
            }
        } finally { inputs.values.forEach { it.close() } }
    }

    companion object {
        @Volatile private var instance: PhoneBgeEncoder? = null
        fun get(context: Context) = instance ?: synchronized(this) {
            instance ?: PhoneBgeEncoder(context.applicationContext).also { instance = it }
        }
    }
}
