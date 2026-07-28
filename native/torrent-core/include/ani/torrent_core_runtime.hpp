#pragma once

#include <memory>
#include <string>
#include <string_view>

namespace ani::torrent_core {

/** 跨桌面 sidecar 与 Android JNI 复用的 libtorrent 运行时。 */
class Runtime {
 public:
  explicit Runtime(std::string data_directory, bool initial_network_policy_blocked = false);
  ~Runtime();

  Runtime(const Runtime&) = delete;
  Runtime& operator=(const Runtime&) = delete;

  /** 执行一条 NDJSON 请求并返回单行 JSON 响应。 */
  std::string execute(std::string_view request_json);

  /** 处理 libtorrent alert、周期恢复数据和做种策略。 */
  void tick();

  /** 保存全部恢复状态并停止运行时。 */
  void shutdown();

  /** 返回是否已收到 shutdown 命令。 */
  bool should_stop() const;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace ani::torrent_core
