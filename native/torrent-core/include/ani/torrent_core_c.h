#pragma once

#ifdef __cplusplus
extern "C" {
#endif

#if defined(__GNUC__) || defined(__clang__)
#define ANI_TORRENT_CORE_API __attribute__((visibility("default")))
#else
#define ANI_TORRENT_CORE_API
#endif

typedef struct ani_torrent_core_handle ani_torrent_core_handle;

/** 创建 Apple 平台核心；失败时 error_message 返回需释放的 UTF-8 文本。 */
ANI_TORRENT_CORE_API ani_torrent_core_handle* ani_torrent_core_start(
    const char* data_directory,
    int initial_network_policy_blocked,
    char** error_message);

/** 执行完整 NDJSON 请求；返回值和错误文本均由 ani_torrent_core_string_free 释放。 */
ANI_TORRENT_CORE_API char* ani_torrent_core_execute(
    ani_torrent_core_handle* handle,
    const char* request_json,
    char** error_message);

/** 保存恢复数据并销毁核心；空句柄可安全重复调用。 */
ANI_TORRENT_CORE_API void ani_torrent_core_stop(ani_torrent_core_handle* handle);

/** 释放 C ABI 返回的字符串。 */
ANI_TORRENT_CORE_API void ani_torrent_core_string_free(char* value);

#ifdef __cplusplus
}
#endif
