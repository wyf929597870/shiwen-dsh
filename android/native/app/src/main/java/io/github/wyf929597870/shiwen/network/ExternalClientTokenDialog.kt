package io.github.wyf929597870.shiwen.network

import io.github.wyf929597870.shiwen.DialogAppearance
import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.os.Build
import android.os.PersistableBundle
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.LifecycleOwner
import org.json.JSONObject

/** Displays an issued credential once in a protected native window. Never returns token data. */
internal object ExternalClientTokenDialog {
    private fun text(activity: Activity, chinese: String, english: String) =
        if (activity.getSharedPreferences("shiwen-appearance", 0).getString("language", "zh-CN") == "en") english else chinese

    fun show(activity: Activity, issued: JSONObject, onClosed: (Boolean) -> Unit) {
        var token: String? = issued.optString("token").takeIf { it.matches(Regex("sw_[A-Za-z0-9_-]{43}")) }
        check(token != null) { "NODE_WRITE_RESULT_UNKNOWN" }
        activity.runOnUiThread {
            if (activity.isFinishing || activity.isDestroyed) {
                token = null
                onClosed(false)
                return@runOnUiThread
            }
            var displayed = false
            val value = TextView(DialogAppearance.native(activity)).apply {
                text = token
                setTextIsSelectable(false)
                textSize = 15f
                setPadding(28, 20, 28, 20)
            }
            val notice = TextView(DialogAppearance.native(activity)).apply {
                text = if (issued.optBoolean("nodeChanged"))
                    this@ExternalClientTokenDialog.text(activity, "创建期间节点配置已更改。此凭据属于原配置中的服务；请核对节点或撤销。关闭后无法再次查看。", "Server settings changed during creation. This credential belongs to the previous server configuration. Verify the node or revoke it. It cannot be viewed again after closing.")
                else this@ExternalClientTokenDialog.text(activity, "这是唯一一次显示。请立即复制并妥善保存；关闭后无法再次查看。", "This credential is shown once. Copy and store it now; it cannot be viewed again after closing.")
                setPadding(28, 18, 28, 10)
            }
            val content = LinearLayout(DialogAppearance.native(activity)).apply {
                orientation = LinearLayout.VERTICAL
                addView(notice)
                addView(value)
            }
            val dialog = AlertDialog.Builder(DialogAppearance.native(activity))
                .setTitle(text(activity, "外部客户端凭据", "External client credential"))
                .setView(ScrollView(DialogAppearance.native(activity)).apply { addView(content) })
                .setPositiveButton(text(activity, "复制凭据", "Copy credential"), null)
                .setNegativeButton(text(activity, "完成", "Done"), null)
                .create()
            val lifecycle = (activity as? LifecycleOwner)?.lifecycle
            val observer = LifecycleEventObserver { _, event ->
                if (event == Lifecycle.Event.ON_STOP || event == Lifecycle.Event.ON_DESTROY) dialog.dismiss()
            }
            dialog.setOnDismissListener {
                lifecycle?.removeObserver(observer)
                value.text = ""
                notice.text = ""
                token = null
                onClosed(displayed)
            }
            lifecycle?.addObserver(observer)
            dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
            dialog.show()
            dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
            displayed = true
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val secret = token ?: return@setOnClickListener
                val clip = ClipData.newPlainText("Shiwen external client token", secret)
                clip.description.extras = PersistableBundle().apply {
                    putBoolean("android.content.extra.IS_SENSITIVE", true)
                }
                (activity.getSystemService(Activity.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(clip)
                notice.text = text(activity, "已复制。该凭据只显示这一次，关闭后无法再次查看。", "Copied. This credential is shown once and cannot be viewed again after closing.")
            }
        }
    }
}
