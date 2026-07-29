# libvlcjni 通过固定二进制类名和成员签名访问 Java API，Release 不得混淆或裁剪。
-keep class org.videolan.libvlc.** { *; }
-keep interface org.videolan.libvlc.** { *; }
