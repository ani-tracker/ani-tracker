#include "ani/torrent_core_c.h"

#include "ani/torrent_core_runtime.hpp"

#include <atomic>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>

namespace {

/** 在 Apple 应用进程内持续驱动 alert，并在停止时同步刷盘。 */
class ManagedCore {
 public:
  ManagedCore(std::string data_directory, bool initial_network_policy_blocked)
      : runtime_(std::move(data_directory), initial_network_policy_blocked),
        worker_([this]() { run(); }) {}

  ~ManagedCore() { stop(); }

  /** 执行一条版本化 NDJSON 请求。 */
  std::string execute(const std::string& request_json) {
    const auto response = runtime_.execute(request_json);
    if (runtime_.should_stop()) running_ = false;
    return response;
  }

  /** 停止维护线程并持久化全部恢复状态。 */
  void stop() {
    if (stopped_.exchange(true)) return;
    running_ = false;
    if (worker_.joinable()) worker_.join();
    runtime_.shutdown();
  }

 private:
  /** 每 100ms 驱动一次 libtorrent 维护循环。 */
  void run() {
    while (running_) {
      try {
        runtime_.tick();
      } catch (...) {
        // C ABI 线程不能把异常传播到 Swift；下一次命令仍会返回结构化错误。
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
  }

  ani::torrent_core::Runtime runtime_;
  std::atomic<bool> running_{true};
  std::atomic<bool> stopped_{false};
  std::thread worker_;
};

/** 为 Swift 创建由 C ABI 管理的字符串副本。 */
char* copy_string(const std::string& value) {
  auto* result = static_cast<char*>(std::malloc(value.size() + 1));
  if (result == nullptr) throw std::bad_alloc();
  std::memcpy(result, value.c_str(), value.size() + 1);
  return result;
}

/** 仅在调用方提供错误槽时写入错误。 */
void set_error(char** error_message, const std::string& message) noexcept {
  if (error_message == nullptr) return;
  try {
    *error_message = copy_string(message);
  } catch (...) {
    *error_message = nullptr;
  }
}

}  // namespace

struct ani_torrent_core_handle {
  ani_torrent_core_handle(std::string data_directory, bool initial_network_policy_blocked)
      : core(std::move(data_directory), initial_network_policy_blocked) {}

  ManagedCore core;
};

extern "C" ani_torrent_core_handle* ani_torrent_core_start(
    const char* data_directory,
    int initial_network_policy_blocked,
    char** error_message) {
  if (error_message != nullptr) *error_message = nullptr;
  try {
    if (data_directory == nullptr || data_directory[0] == '\0') {
      throw std::invalid_argument("下载核心数据目录不能为空");
    }
    return new ani_torrent_core_handle(data_directory, initial_network_policy_blocked != 0);
  } catch (const std::exception& error) {
    set_error(error_message, error.what());
    return nullptr;
  } catch (...) {
    set_error(error_message, "创建下载核心时发生未知错误");
    return nullptr;
  }
}

extern "C" char* ani_torrent_core_execute(
    ani_torrent_core_handle* handle,
    const char* request_json,
    char** error_message) {
  if (error_message != nullptr) *error_message = nullptr;
  try {
    if (handle == nullptr) throw std::invalid_argument("下载核心句柄不能为空");
    if (request_json == nullptr || request_json[0] == '\0') {
      throw std::invalid_argument("下载核心请求不能为空");
    }
    return copy_string(handle->core.execute(request_json));
  } catch (const std::exception& error) {
    set_error(error_message, error.what());
    return nullptr;
  } catch (...) {
    set_error(error_message, "执行下载核心请求时发生未知错误");
    return nullptr;
  }
}

extern "C" void ani_torrent_core_stop(ani_torrent_core_handle* handle) {
  delete handle;
}

extern "C" void ani_torrent_core_string_free(char* value) {
  std::free(value);
}
