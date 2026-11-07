package io.github.wyf929597870.shiwen

import android.app.Activity
import android.content.Context
import android.content.res.Configuration
import android.view.ContextThemeWrapper

internal object DialogAppearance {
    private fun dark(activity: Activity): Boolean {
        val theme = activity.getSharedPreferences("shiwen-appearance", 0).getString("theme", "system")
        return theme == "dark" || theme == "system" &&
            (activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    }
    fun native(activity: Activity): Context = ContextThemeWrapper(activity,
        if (dark(activity)) android.R.style.Theme_Material_Dialog_Alert else android.R.style.Theme_Material_Light_Dialog_Alert)
    fun compat(activity: Activity): Context = ContextThemeWrapper(activity,
        if (dark(activity)) androidx.appcompat.R.style.Theme_AppCompat_Dialog_Alert else androidx.appcompat.R.style.Theme_AppCompat_Light_Dialog_Alert)
}
