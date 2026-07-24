# 已安装的 libtorrent 导出目标会引用 OpenSSL，需在 qBittorrent 导入前创建对应目标。
if(NOT TARGET OpenSSL::SSL OR NOT TARGET OpenSSL::Crypto)
  find_package(OpenSSL REQUIRED)
endif()
