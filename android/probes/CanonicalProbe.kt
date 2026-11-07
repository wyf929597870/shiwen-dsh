import io.github.wyf929597870.shiwen.model.Canonical
import kotlinx.serialization.json.*
import java.io.File

fun convert(v: JsonElement): Any? = when(v) {
    JsonNull -> null
    is JsonObject -> v.mapValues { convert(it.value) }
    is JsonArray -> v.map { convert(it) }
    is JsonPrimitive -> if(v.isString) v.content else v.booleanOrNull ?: v.longOrNull ?: error("not an integer")
}
fun main(args: Array<String>) {
    val fixtures = Json.parseToJsonElement(File(args[0]).readText()).jsonArray
    for (fixture in fixtures) {
        val row = fixture.jsonObject
        val value = convert(row.getValue("value"))
        check(Canonical.encode(value) == row.getValue("canonical").jsonPrimitive.content) { "canonical mismatch: ${row["name"]}" }
        check(Canonical.hash(value) == row.getValue("sha256").jsonPrimitive.content) { "hash mismatch: ${row["name"]}" }
    }
    for (bad in listOf("\uD800", "\uDC00", 0.5, 9007199254740992L)) {
        check(runCatching { Canonical.encode(bad) }.isFailure) { "accepted invalid input" }
    }
    check("🌱".repeat(500_000).length == 1_000_000)
    println("PASS: ${fixtures.size} canonical fixtures + Unicode/integer/UTF-16 boundaries (Kotlin/JVM, not Android runtime)")
}
