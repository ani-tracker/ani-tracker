cmake_minimum_required(VERSION 3.24)

if(POLICY CMP0167)
  cmake_policy(SET CMP0167 OLD)
endif()

project(ani_torrent_core VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(ANI_FETCH_LIBTORRENT "Build the pinned libtorrent source instead of using a system package" OFF)
option(ANI_BUILD_SIDECAR "Build the desktop torrent-core executable" ON)
option(ANI_BUILD_ANDROID_JNI "Build the Android JNI bridge" OFF)

if(ANI_FETCH_LIBTORRENT)
  include(FetchContent)
  set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
  set(shared OFF CACHE BOOL "" FORCE)
  set(build_tests OFF CACHE BOOL "" FORCE)
  set(build_examples OFF CACHE BOOL "" FORCE)
  set(build_tools OFF CACHE BOOL "" FORCE)
  set(python-bindings OFF CACHE BOOL "" FORCE)
  set(webtorrent OFF CACHE BOOL "" FORCE)
  set(gnutls OFF CACHE BOOL "" FORCE)
  set(encryption ON CACHE BOOL "" FORCE)
  if(MSVC)
    set(static_runtime ON CACHE BOOL "" FORCE)
  endif()
  set(OPENSSL_USE_STATIC_LIBS TRUE CACHE BOOL "" FORCE)
  FetchContent_Declare(
    libtorrent_rasterbar
    URL https://github.com/arvidn/libtorrent/releases/download/v2.1.0/libtorrent-rasterbar-2.1.0.tar.gz
    URL_HASH SHA256=ceed657606b8df453ec5e775326e3c759a2779e1202fa04abe42ed262e7bf0b6
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE
  )
  FetchContent_MakeAvailable(libtorrent_rasterbar)
else()
  find_package(LibtorrentRasterbar 2.1 CONFIG QUIET)
endif()

if(TARGET torrent-rasterbar AND NOT TARGET LibtorrentRasterbar::torrent-rasterbar)
  add_library(LibtorrentRasterbar::torrent-rasterbar ALIAS torrent-rasterbar)
endif()

if(NOT TARGET LibtorrentRasterbar::torrent-rasterbar)
  message(FATAL_ERROR "libtorrent-rasterbar 2.1 is required. Set CMAKE_PREFIX_PATH or enable ANI_FETCH_LIBTORRENT.")
endif()

add_library(ani-torrent-core-runtime STATIC src/torrent_core_runtime.cpp)
set_target_properties(ani-torrent-core-runtime PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_include_directories(ani-torrent-core-runtime PUBLIC include)
target_link_libraries(ani-torrent-core-runtime PUBLIC LibtorrentRasterbar::torrent-rasterbar)
target_compile_definitions(ani-torrent-core-runtime PRIVATE ANI_TORRENT_CORE_VERSION="${PROJECT_VERSION}")

if(MSVC)
  target_compile_options(ani-torrent-core-runtime PRIVATE /W4 /permissive-)
else()
  target_compile_options(ani-torrent-core-runtime PRIVATE -Wall -Wextra -Wpedantic)
endif()

if(ANI_BUILD_SIDECAR)
  add_executable(torrent-core src/sidecar_main.cpp)
  target_link_libraries(torrent-core PRIVATE ani-torrent-core-runtime)
  if(MSVC)
    target_compile_options(torrent-core PRIVATE /W4 /permissive-)
  else()
    target_compile_options(torrent-core PRIVATE -Wall -Wextra -Wpedantic)
  endif()
  install(TARGETS torrent-core RUNTIME DESTINATION .)
endif()

if(ANI_BUILD_ANDROID_JNI)
  if(NOT ANDROID)
    message(FATAL_ERROR "ANI_BUILD_ANDROID_JNI requires the Android NDK toolchain")
  endif()
  add_library(ani_torrent_core SHARED src/android_jni.cpp)
  target_link_libraries(ani_torrent_core PRIVATE ani-torrent-core-runtime log android)
  target_compile_options(ani_torrent_core PRIVATE -Wall -Wextra -Wpedantic)
endif()
