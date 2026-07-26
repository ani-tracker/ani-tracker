package com.ani.tracker

import android.os.Bundle
import androidx.activity.enableEdgeToEdge

/** 承载 Ani Tracker Tauri WebView，并启用系统边到边布局。 */
class MainActivity : TauriActivity() {
  /** 初始化移动宿主后交由 TauriActivity 装配 Rust 核心与原生插件。 */
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }
}
