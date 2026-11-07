package io.github.wyf929597870.shiwen.testing

import android.app.Activity
import android.os.Bundle
import android.view.Gravity
import android.view.WindowManager
import android.widget.TextView

/** Debug-only foreground surface; never reads the user's library or credentials. */
class IntegrationTestActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        // Show only this generic test status over the keyguard. This does not
        // dismiss the keyguard or expose documents, credentials, or production UI.
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        setContentView(TextView(this).apply {
            text = "拾文 · 正在进行同步与存储测试\n\n请暂时保持此页面在前台。\n测试结束后此页面会自动关闭。\n\nShiwen integration tests are running."
            textSize = 18f; gravity = Gravity.CENTER; setPadding(32, 32, 32, 32)
        })
    }
}
