# JNI 使用静态符号名解析，宿主开启 R8 后仍须保留 native 方法名。
-keep class dev.ani.tracker.torrent.NativeTorrentCore {
    native <methods>;
}
