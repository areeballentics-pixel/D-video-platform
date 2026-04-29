package com.svp.player

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * React Native package wiring. Add to MainApplication.kt:
 *
 *     override fun getPackages(): List<ReactPackage> =
 *         PackageList(this).packages.apply {
 *             add(SvpVideoPlayerPackage())
 *         }
 */
class SvpVideoPlayerPackage : ReactPackage {
    override fun createNativeModules(
        reactContext: ReactApplicationContext,
    ): List<NativeModule> = listOf(SvpVideoPlayerModule(reactContext))

    override fun createViewManagers(
        reactContext: ReactApplicationContext,
    ): List<ViewManager<*, *>> = emptyList()
}
