package io.github.wyf929597870.shiwen.library

import io.github.wyf929597870.shiwen.DialogAppearance
import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.text.InputType
import android.view.ViewGroup
import android.view.WindowManager
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import androidx.appcompat.app.AlertDialog
import java.util.concurrent.atomic.AtomicBoolean

/** Native-only passphrase prompts. Callers must not resolve the passphrase to JavaScript. */
internal object LibraryArchivePasswordDialog {
    data class ExportChoice(val encrypted: Boolean, val password: CharArray? = null)

    fun chooseExport(activity: Activity, language: String = "zh-CN", onResult: (ExportChoice?) -> Unit) {
        val done = AtomicBoolean(false)
        var transitioning = false
        var stopWatching: () -> Unit = {}
        var dialog: AlertDialog? = null
        fun finish(value: ExportChoice?) {
            if (done.compareAndSet(false, true)) { stopWatching(); onResult(value) }
            else value?.password?.fill('\u0000')
        }
        activity.runOnUiThread {
            if (activity.isFinishing || activity.isDestroyed) { finish(null); return@runOnUiThread }
            dialog = AlertDialog.Builder(DialogAppearance.compat(activity))
                .setTitle(text(language,"导出资料库备份","Export library backup"))
                .setMessage(text(language,
                    "完整备份包含资料、历史版本、来源和附件。若附件尚未下载，导出会失败并提示先同步。可以加密，也可以导出未加密 ZIP。",
                    "A full backup includes records, versions, provenance, and attachments. Export fails if an attachment is not downloaded. Choose encryption or an unencrypted ZIP."))
                .setItems(arrayOf(text(language,"加密备份…","Encrypted backup…"), text(language,"未加密 ZIP","Unencrypted ZIP"))) { _, which ->
                    if (which == 0) {
                        if (!done.get()) {
                            transitioning = true
                            stopWatching()
                            dialog?.dismiss()
                            requestNewPassword(activity,language) { password ->
                                finish(password?.let { ExportChoice(true, it) })
                            }
                        }
                    } else finish(ExportChoice(false))
                }
                .create()
            dialog?.setOnCancelListener { finish(null) }
            dialog?.setOnDismissListener { if (!done.get() && !transitioning) finish(null) }
            stopWatching = watchDestroy(activity) { dialog?.dismiss(); finish(null) }
            dialog?.show()
        }
    }

    fun requestRestorePassword(activity: Activity, language: String = "zh-CN", onResult: (CharArray?) -> Unit) {
        passwordPrompt(activity, language, text(language,"解锁备份","Unlock backup"),
            text(language,"输入创建此备份时设置的密码","Enter the password used to create this backup"), confirm = false, onResult)
    }

    private fun requestNewPassword(activity: Activity, language: String, onResult: (CharArray?) -> Unit) {
        passwordPrompt(activity, language, text(language,"设置备份密码","Set backup password"),
            text(language,"至少 8 个字符。密码不会保存在手机中。","At least 8 characters. The password is not stored on this phone."), confirm = true, onResult)
    }

    private fun passwordPrompt(activity: Activity, language: String, title: String, message: String, confirm: Boolean,
        onResult: (CharArray?) -> Unit) {
        activity.runOnUiThread {
            val callbackSent = AtomicBoolean(false)
            var stopWatching: () -> Unit = {}
            var dialog: AlertDialog? = null
            var password: EditText? = null
            var confirmation: EditText? = null
            fun finish(value: CharArray?) {
                if (callbackSent.compareAndSet(false, true)) {
                    stopWatching()
                    password?.text?.clear(); confirmation?.text?.clear()
                    onResult(value)
                } else value?.fill('\u0000')
            }
            if (activity.isFinishing || activity.isDestroyed) { finish(null); return@runOnUiThread }
            password = passwordField(activity, text(language,"密码","Password"))
            confirmation = if (confirm) passwordField(activity, text(language,"再次输入密码","Confirm password")) else null
            val fields = LinearLayout(DialogAppearance.compat(activity)).apply {
                orientation = LinearLayout.VERTICAL
                val pad = (20 * resources.displayMetrics.density).toInt()
                setPadding(pad, 0, pad, 0)
                addView(password, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
                confirmation?.let { addView(it, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT) }
            }
            dialog = AlertDialog.Builder(DialogAppearance.compat(activity)).setTitle(title).setMessage(message).setView(fields)
                .setNegativeButton(text(language,"取消","Cancel")) { _, _ -> finish(null) }
                .setPositiveButton(if (confirm) text(language,"继续","Continue") else text(language,"解锁","Unlock"), null)
                .create()
            var accepted = false
            dialog?.setOnCancelListener { finish(null) }
            dialog?.setOnDismissListener {
                password?.text?.clear(); confirmation?.text?.clear()
                if (!accepted) finish(null)
            }
            dialog?.setOnShowListener {
                dialog?.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
                dialog?.getButton(AlertDialog.BUTTON_POSITIVE)?.setOnClickListener {
                    val first = password?.text?.toString()?.toCharArray() ?: charArrayOf()
                    val second = confirmation?.text?.toString()?.toCharArray()
                    if (first.size !in 8..256) {
                        password?.error = text(language,"密码至少 8 个字符","Password must have at least 8 characters")
                        first.fill('\u0000'); second?.fill('\u0000')
                        return@setOnClickListener
                    }
                    if (confirm && !first.contentEquals(second)) {
                        confirmation?.error = text(language,"两次输入不一致","Passwords do not match")
                        first.fill('\u0000'); second?.fill('\u0000')
                        return@setOnClickListener
                    }
                    confirmation?.text?.clear(); password?.text?.clear()
                    second?.fill('\u0000')
                    accepted = true
                    dialog?.dismiss()
                    finish(first)
                }
            }
            stopWatching = watchDestroy(activity) { dialog?.dismiss(); finish(null) }
            dialog?.show()
        }
    }

    private fun passwordField(activity: Activity, hintText: String) = EditText(DialogAppearance.compat(activity)).apply {
        hint = hintText
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        setSingleLine(true)
        importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
    }

    private fun text(language: String, chinese: String, english: String) =
        if (language.lowercase().startsWith("en")) english else chinese

    private fun watchDestroy(activity: Activity, onDestroyed: () -> Unit): () -> Unit {
        val callbacks = object : Application.ActivityLifecycleCallbacks {
            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
            override fun onActivityStarted(activity: Activity) = Unit
            override fun onActivityResumed(activity: Activity) = Unit
            override fun onActivityPaused(activity: Activity) = Unit
            override fun onActivityStopped(activity: Activity) = Unit
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
            override fun onActivityDestroyed(candidate: Activity) { if (candidate === activity) onDestroyed() }
        }
        activity.application.registerActivityLifecycleCallbacks(callbacks)
        return { runCatching { activity.application.unregisterActivityLifecycleCallbacks(callbacks) } }
    }
}
