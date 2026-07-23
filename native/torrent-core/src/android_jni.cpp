#include "ani/torrent_core_runtime.hpp"

#include <android/log.h>
#include <jni.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

namespace {

constexpr char log_tag[] = "AniTorrentCore";

/** 在后台持续处理 alert，避免 Android 调用间隔影响恢复状态。 */
class ManagedCore {
 public:
  explicit ManagedCore(std::string data_directory)
      : runtime_(std::move(data_directory)), worker_([this]() { run(); }) {
    __android_log_print(ANDROID_LOG_INFO, log_tag, "native core started");
  }

  ~ManagedCore() { stop(); }

  /** 执行一条与桌面端一致的 NDJSON 请求。 */
  std::string execute(const std::string& request_json) {
    const auto response = runtime_.execute(request_json);
    if (runtime_.should_stop()) running_ = false;
    return response;
  }

  /** 停止后台循环并持久化全部状态。 */
  void stop() {
    if (stopped_.exchange(true)) return;
    running_ = false;
    if (worker_.joinable()) worker_.join();
    runtime_.shutdown();
    __android_log_print(ANDROID_LOG_INFO, log_tag, "native core stopped");
  }

 private:
  /** 每 100ms 驱动一次 libtorrent 维护循环。 */
  void run() {
    while (running_) {
      try {
        runtime_.tick();
      } catch (const std::exception& error) {
        __android_log_print(ANDROID_LOG_ERROR, log_tag, "tick failed: %s", error.what());
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
  }

  ani::torrent_core::Runtime runtime_;
  std::atomic<bool> running_{true};
  std::atomic<bool> stopped_{false};
  std::thread worker_;
};

std::mutex registry_mutex;
std::unordered_map<std::int64_t, std::shared_ptr<ManagedCore>> registry;
std::atomic<std::int64_t> next_handle{1};

/** 将 Java 字符串安全转换为 UTF-8。 */
std::string to_string(JNIEnv* env, jstring value) {
  if (value == nullptr) throw std::invalid_argument("字符串参数不能为空");
  const char* chars = env->GetStringUTFChars(value, nullptr);
  if (chars == nullptr) throw std::runtime_error("无法读取 Java 字符串");
  std::string result(chars);
  env->ReleaseStringUTFChars(value, chars);
  return result;
}

/** 抛出 Java IllegalStateException。 */
void throw_illegal_state(JNIEnv* env, const std::string& message) {
  const jclass exception_class = env->FindClass("java/lang/IllegalStateException");
  if (exception_class != nullptr) env->ThrowNew(exception_class, message.c_str());
}

/** 查找活动核心，并通过 shared_ptr 保证并发停止安全。 */
std::shared_ptr<ManagedCore> require_core(std::int64_t handle) {
  std::lock_guard<std::mutex> lock(registry_mutex);
  const auto found = registry.find(handle);
  if (found == registry.end()) throw std::runtime_error("Android 下载核心句柄不存在");
  return found->second;
}

}  // namespace

extern "C" JNIEXPORT jlong JNICALL
Java_dev_ani_tracker_torrent_NativeTorrentCore_nativeStart(JNIEnv* env, jobject, jstring data_directory) {
  try {
    const auto handle = next_handle.fetch_add(1);
    auto core = std::make_shared<ManagedCore>(to_string(env, data_directory));
    {
      std::lock_guard<std::mutex> lock(registry_mutex);
      registry.emplace(handle, std::move(core));
    }
    return static_cast<jlong>(handle);
  } catch (const std::exception& error) {
    throw_illegal_state(env, error.what());
    return 0;
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_dev_ani_tracker_torrent_NativeTorrentCore_nativeExecute(
    JNIEnv* env, jobject, jlong handle, jstring request_json) {
  try {
    const auto response = require_core(static_cast<std::int64_t>(handle))->execute(to_string(env, request_json));
    return env->NewStringUTF(response.c_str());
  } catch (const std::exception& error) {
    throw_illegal_state(env, error.what());
    return nullptr;
  }
}

extern "C" JNIEXPORT void JNICALL
Java_dev_ani_tracker_torrent_NativeTorrentCore_nativeStop(JNIEnv* env, jobject, jlong handle) {
  try {
    std::shared_ptr<ManagedCore> core;
    {
      std::lock_guard<std::mutex> lock(registry_mutex);
      const auto found = registry.find(static_cast<std::int64_t>(handle));
      if (found == registry.end()) return;
      core = std::move(found->second);
      registry.erase(found);
    }
    core->stop();
  } catch (const std::exception& error) {
    throw_illegal_state(env, error.what());
  }
}

extern "C" JNIEXPORT void JNICALL JNI_OnUnload(JavaVM*, void*) {
  std::vector<std::shared_ptr<ManagedCore>> cores;
  {
    std::lock_guard<std::mutex> lock(registry_mutex);
    for (auto& [handle, core] : registry) {
      static_cast<void>(handle);
      cores.push_back(std::move(core));
    }
    registry.clear();
  }
  for (const auto& core : cores) core->stop();
}
