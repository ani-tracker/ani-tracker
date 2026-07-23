#include "ani/torrent_core_runtime.hpp"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <csignal>
#include <filesystem>
#include <iostream>
#include <mutex>
#include <optional>
#include <queue>
#include <stdexcept>
#include <string>
#include <thread>

namespace fs = std::filesystem;

namespace {

std::atomic<bool> signal_stop{false};

/** 处理 SIGINT/SIGTERM，交由主循环优雅退出。 */
void handle_signal(int) { signal_stop = true; }

/** 解析命令行中的核心数据目录。 */
fs::path parse_data_directory(int argc, char** argv) {
  for (int index = 1; index < argc - 1; ++index) {
    if (std::string(argv[index]) == "--data-dir") return fs::absolute(argv[index + 1]);
  }
  throw std::runtime_error("缺少 --data-dir 参数");
}

}  // namespace

int main(int argc, char** argv) {
  try {
    std::signal(SIGINT, handle_signal);
    std::signal(SIGTERM, handle_signal);

    ani::torrent_core::Runtime runtime(parse_data_directory(argc, argv).string());
    std::mutex queue_mutex;
    std::condition_variable queue_changed;
    std::queue<std::string> requests;
    std::atomic<bool> input_closed{false};

    std::thread reader([&]() {
      std::string line;
      while (std::getline(std::cin, line)) {
        {
          std::lock_guard<std::mutex> lock(queue_mutex);
          requests.push(std::move(line));
        }
        queue_changed.notify_one();
      }
      input_closed = true;
      queue_changed.notify_one();
    });

    while (!runtime.should_stop() && !signal_stop) {
      std::optional<std::string> request;
      {
        std::unique_lock<std::mutex> lock(queue_mutex);
        queue_changed.wait_for(lock, std::chrono::milliseconds(100), [&]() {
          return !requests.empty() || input_closed.load() || signal_stop.load();
        });
        if (!requests.empty()) {
          request = std::move(requests.front());
          requests.pop();
        }
      }
      if (request) std::cout << runtime.execute(*request) << '\n' << std::flush;
      runtime.tick();
      if (input_closed && !request) break;
    }

    runtime.shutdown();
    if (reader.joinable()) reader.join();
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "[torrent-core] fatal: " << error.what() << '\n';
    return 1;
  }
}
