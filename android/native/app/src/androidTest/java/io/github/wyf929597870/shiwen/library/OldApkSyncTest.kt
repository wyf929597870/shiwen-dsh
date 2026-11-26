package io.github.wyf929597870.shiwen.library

import android.app.Instrumentation
import android.os.Bundle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dalvik.system.PathClassLoader
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Loads the installed release APK's unmodified Room and sync code for the existing host fixture. */
@RunWith(AndroidJUnit4::class)
class OldApkSyncTest {
    @Test fun releaseClientUsesOrdinarySnapshotAndEdits(){
        val args=InstrumentationRegistry.getArguments()
        val apk=args.getString("oldApkPath")
        assumeTrue(apk!=null && args.containsKey("syntheticHost"))
        require(apk!!.startsWith("/data/app/") && apk.endsWith("/base.apk"))
        val instrumentation=InstrumentationRegistry.getInstrumentation()
        val tests=instrumentation.context.applicationInfo.sourceDir
        val release=PathClassLoader(apk,ClassLoader.getSystemClassLoader().parent)
        val fixture=PathClassLoader(tests,release)
        val coordinator=fixture.loadClass("io.github.wyf929597870.shiwen.library.LibrarySyncCoordinator")
        check(coordinator.classLoader===release)
        check(runCatching {release.loadClass("io.github.wyf929597870.shiwen.library.PhoneExploration")}.isFailure)
        val registry=fixture.loadClass("androidx.test.platform.app.InstrumentationRegistry")
        registry.getMethod("registerInstance",Instrumentation::class.java,Bundle::class.java).invoke(null,instrumentation,args)
        val test=fixture.loadClass("io.github.wyf929597870.shiwen.library.LibrarySyncHostTest")
        try{test.getMethod("fullSnapshotAndRepeatedOfflineEditsConvergeWithRealHost").invoke(test.getConstructor().newInstance())}
        catch(e:java.lang.reflect.InvocationTargetException){throw e.targetException}
    }
}
