package io.github.wyf929597870.shiwen.library

import org.junit.Assert.assertEquals
import org.junit.Test

class PhoneExplorationMarkdownTest {
    @Test fun headingsRespectFencesExamplesAndLegacyBoundaries(){
        val text=listOf("## 待探索","- 普通样例","## AI 批注","### 待探索","- 保留原问法",
            "  还有上下文","> ### 待跟进","> - 引用样例","~~~","### 待探索","- 代码样例","~~~",
            "### 待跟进","1. 后来怎么样了？","## 我的正文","- 正文列表").joinToString("\n")
        val expected=listOf("explore" to "保留原问法\n还有上下文","follow_up" to "后来怎么样了？")
        assertEquals(expected,extractExplorationList(text,true))
        assertEquals(listOf("explore" to "普通样例")+expected,extractExplorationList(text))
    }
}
