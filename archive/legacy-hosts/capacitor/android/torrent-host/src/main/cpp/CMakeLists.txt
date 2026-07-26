cmake_minimum_required(VERSION 3.24)

project(ani_torrent_android LANGUAGES CXX)

add_subdirectory(
  "${CMAKE_CURRENT_LIST_DIR}/../../../../../native/torrent-core"
  "${CMAKE_CURRENT_BINARY_DIR}/torrent-core"
)
