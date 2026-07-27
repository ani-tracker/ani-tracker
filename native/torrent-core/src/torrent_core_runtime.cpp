#include "ani/torrent_core_runtime.hpp"

#include <libtorrent/add_torrent_params.hpp>
#include <libtorrent/alert_types.hpp>
#include <libtorrent/error_code.hpp>
#include <libtorrent/magnet_uri.hpp>
#include <libtorrent/read_resume_data.hpp>
#include <libtorrent/session.hpp>
#include <libtorrent/session_params.hpp>
#include <libtorrent/settings_pack.hpp>
#include <libtorrent/torrent_handle.hpp>
#include <libtorrent/torrent_info.hpp>
#include <libtorrent/torrent_status.hpp>
#include <libtorrent/write_resume_data.hpp>

#include <boost/property_tree/json_parser.hpp>
#include <boost/property_tree/ptree.hpp>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <csignal>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <map>
#include <mutex>
#include <optional>
#include <queue>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace fs = std::filesystem;
namespace lt = libtorrent;
namespace pt = boost::property_tree;

#ifndef ANI_TORRENT_CORE_VERSION
#define ANI_TORRENT_CORE_VERSION "dev"
#endif

namespace {

using Clock = std::chrono::steady_clock;

class TaskNotFoundError final : public std::runtime_error {
 public:
  explicit TaskNotFoundError(const std::string& message) : std::runtime_error(message) {}
};

struct Command {
  std::string id;
  std::string method;
  pt::ptree params;
};

struct CoreSettings {
  int listen_port = 51413;
  bool dht_enabled = true;
  bool upnp_enabled = true;
  int max_active_downloads = 3;
  int max_download_speed_kib = 0;
  int max_upload_speed_kib = 0;
  bool seeding_limits_enabled = false;
  bool ratio_limit_enabled = false;
  double ratio_limit = 1.0;
  bool time_limit_enabled = false;
  int time_limit_minutes = 120;
};

struct TaskMetadata {
  std::string correlation_tag;
  std::string created_at;
  std::string completed_at;
  std::optional<bool> paused;
};

/** 返回当前 UTC 时间，作为跨端稳定时间字段。 */
std::string now_iso() {
  const auto now = std::chrono::system_clock::now();
  const auto seconds = std::chrono::system_clock::to_time_t(now);
  std::tm utc{};
#ifdef _WIN32
  gmtime_s(&utc, &seconds);
#else
  gmtime_r(&seconds, &utc);
#endif
  std::ostringstream output;
  output << std::put_time(&utc, "%Y-%m-%dT%H:%M:%SZ");
  return output.str();
}

/** 将二进制 info hash 转换为小写十六进制任务标识。 */
std::string hash_hex(const lt::sha1_hash& hash) {
  static constexpr char digits[] = "0123456789abcdef";
  std::string result;
  result.reserve(hash.size() * 2);
  for (const auto byte : hash) {
    const auto value = static_cast<unsigned char>(byte);
    result.push_back(digits[value >> 4]);
    result.push_back(digits[value & 0x0f]);
  }
  return result;
}

/** 返回 torrent handle 的稳定 info hash。 */
std::string task_id(const lt::torrent_handle& handle) {
  return hash_hex(handle.info_hashes().get_best());
}

/** 原子写入二进制状态文件，避免异常退出留下半文件。 */
void write_binary_atomic(const fs::path& path, const std::vector<char>& data) {
  fs::create_directories(path.parent_path());
  const fs::path temporary = path.string() + ".tmp";
  {
    std::ofstream output(temporary, std::ios::binary | std::ios::trunc);
    if (!output) throw std::runtime_error("无法写入状态文件");
    output.write(data.data(), static_cast<std::streamsize>(data.size()));
    output.flush();
    if (!output) throw std::runtime_error("状态文件写入不完整");
  }
  std::error_code ignored;
  fs::remove(path, ignored);
  fs::rename(temporary, path);
}

/** 原子写入 JSON 元数据。 */
void write_json_atomic(const fs::path& path, const pt::ptree& tree) {
  fs::create_directories(path.parent_path());
  const fs::path temporary = path.string() + ".tmp";
  pt::write_json(temporary.string(), tree, std::locale(), false);
  std::error_code ignored;
  fs::remove(path, ignored);
  fs::rename(temporary, path);
}

/** 读取完整二进制文件；不存在时返回空数组。 */
std::vector<char> read_binary(const fs::path& path) {
  std::ifstream input(path, std::ios::binary);
  if (!input) return {};
  return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}

/** 将 property_tree 序列化为单行 JSON。 */
std::string serialize_json(const pt::ptree& tree) {
  std::ostringstream output;
  pt::write_json(output, tree, false);
  std::string line = output.str();
  line.erase(std::remove(line.begin(), line.end(), '\n'), line.end());
  return line;
}

/** 构造成功响应。 */
std::string success_response(const std::string& id, const pt::ptree& result) {
  pt::ptree response;
  response.put("id", id);
  response.put("ok", true);
  response.add_child("result", result);
  return serialize_json(response);
}

/** 构造结构化失败响应。 */
std::string error_response(const std::string& id, const std::string& code, const std::string& message) {
  pt::ptree response;
  response.put("id", id);
  response.put("ok", false);
  pt::ptree error;
  error.put("code", code);
  error.put("message", message);
  response.add_child("error", error);
  return serialize_json(response);
}

/** 将数组节点加入 property_tree。 */
template <typename T, typename Mapper>
pt::ptree map_array(const std::vector<T>& values, Mapper mapper) {
  pt::ptree result;
  for (const auto& value : values) result.push_back({"", mapper(value)});
  return result;
}

/** 将 libtorrent 状态转换为应用统一状态。 */
std::string map_status(const lt::torrent_status& status, bool paused) {
  if (status.errc) return "error";
  if (status.moving_storage) return "moving";
  if (paused) return "paused";
  switch (status.state) {
    case lt::torrent_status::checking_files:
    case lt::torrent_status::checking_resume_data:
      return "checking";
    case lt::torrent_status::downloading_metadata:
      return "fetching_metadata";
    case lt::torrent_status::downloading:
      return status.download_payload_rate == 0 ? "stalled" : "downloading";
    case lt::torrent_status::finished:
      return "completed";
    case lt::torrent_status::seeding:
      return "seeding";
    default:
      return "queued";
  }
}

/** 从命令参数读取文件索引数组。 */
std::vector<int> read_indexes(const pt::ptree& params, const std::string& key) {
  std::vector<int> indexes;
  const auto child = params.get_child_optional(key);
  if (!child) return indexes;
  for (const auto& item : *child) indexes.push_back(item.second.get_value<int>());
  return indexes;
}

/** 处理 libtorrent Session、任务和恢复状态。 */
class TorrentCore {
 public:
  /** 从数据目录恢复 Session 和任务。 */
  explicit TorrentCore(fs::path data_directory)
      : data_directory_(std::move(data_directory)),
        resume_directory_(data_directory_ / "resume"),
        session_(create_session_params()) {
    fs::create_directories(resume_directory_);
    load_metadata();
    restore_torrents();
    apply_settings();
    std::cerr << "[torrent-core] started version=" << ANI_TORRENT_CORE_VERSION << '\n';
  }

  /** 执行一条 IPC 命令并返回结果。 */
  pt::ptree execute(const Command& command, bool& should_stop) {
    if (command.method == "status") return status();
    if (command.method == "configure") return configure(command.params);
    if (command.method == "addMagnet") return add_magnet(command.params);
    if (command.method == "addTorrentFile") return add_torrent_file(command.params);
    if (command.method == "listTasks") return list_tasks();
    if (command.method == "getTask") return get_task(command.params);
    if (command.method == "getFiles") return get_files(command.params);
    if (command.method == "setFilePriority") return set_file_priority(command.params);
    if (command.method == "pause") return pause(command.params);
    if (command.method == "resume") return resume(command.params);
    if (command.method == "remove") return remove(command.params);
    if (command.method == "shutdown") {
      save_all_state(std::chrono::seconds(8));
      should_stop = true;
      pt::ptree result;
      result.put("stopped", true);
      return result;
    }
    throw std::runtime_error("未知核心命令: " + command.method);
  }

  /** 处理 alert、周期恢复数据和做种停止策略。 */
  void tick() {
    process_alerts();
    enforce_seeding_limits();
    if (Clock::now() - last_resume_save_ >= std::chrono::seconds(30)) {
      request_resume_save(false);
      last_resume_save_ = Clock::now();
    }
  }

  /** 在进程结束前持久化全部状态。 */
  void shutdown() {
    try {
      save_all_state(std::chrono::seconds(8));
    } catch (const std::exception& error) {
      std::cerr << "[torrent-core] shutdown save failed: " << error.what() << '\n';
    }
  }

 private:
  /** 读取 session.state 并构造 Session 参数。 */
  lt::session_params create_session_params() const {
    const auto data = read_binary(data_directory_ / "session.state");
    if (data.empty()) return lt::session_params();
    try {
      return lt::read_session_params(data);
    } catch (const std::exception& error) {
      std::cerr << "[torrent-core] session state ignored: " << error.what() << '\n';
      return lt::session_params();
    }
  }

  /** 从 fastresume 文件恢复所有任务。 */
  void restore_torrents() {
    for (const auto& entry : fs::directory_iterator(resume_directory_)) {
      if (!entry.is_regular_file() || entry.path().extension() != ".fastresume") continue;
      const auto data = read_binary(entry.path());
      lt::error_code error;
      auto params = lt::read_resume_data(data, error);
      if (error) {
        std::cerr << "[torrent-core] resume ignored file=" << entry.path().filename().string()
                  << " message=" << error.message() << '\n';
        continue;
      }
      const std::string id = hash_hex(params.info_hashes.get_best());
      auto& metadata = metadata_[id];
      const bool has_metadata_pause = metadata.paused.has_value();
      const bool fastresume_paused = bool(params.flags & lt::torrent_flags::paused);
      const bool should_pause = metadata.paused.value_or(fastresume_paused);
      if (should_pause) {
        params.flags |= lt::torrent_flags::paused;
        params.flags &= ~lt::torrent_flags::auto_managed;
      } else if (metadata.paused.has_value()) {
        params.flags &= ~lt::torrent_flags::paused;
        params.flags |= lt::torrent_flags::auto_managed;
      }
      if (!metadata.paused.has_value()) metadata.paused = fastresume_paused;
      std::cerr << "[torrent-core] restored task=" << id << " paused=" << should_pause
                << " source=" << (has_metadata_pause ? "metadata" : "fastresume") << '\n';
      session_.async_add_torrent(std::move(params));
    }
  }

  /** 从任务元数据文件恢复关联字段。 */
  void load_metadata() {
    const fs::path path = data_directory_ / "tasks.json";
    if (!fs::exists(path)) return;
    try {
      pt::ptree root;
      pt::read_json(path.string(), root);
      for (const auto& item : root) {
        TaskMetadata metadata;
        metadata.correlation_tag = item.second.get<std::string>("correlationTag", "");
        metadata.created_at = item.second.get<std::string>("createdAt", "");
        metadata.completed_at = item.second.get<std::string>("completedAt", "");
        if (const auto paused = item.second.get_optional<bool>("paused")) {
          metadata.paused = *paused;
        }
        metadata_[item.first] = std::move(metadata);
      }
    } catch (const std::exception& error) {
      std::cerr << "[torrent-core] task metadata ignored: " << error.what() << '\n';
    }
  }

  /** 原子保存任务关联元数据。 */
  void save_metadata() const {
    pt::ptree root;
    for (const auto& [id, value] : metadata_) {
      pt::ptree item;
      item.put("correlationTag", value.correlation_tag);
      item.put("createdAt", value.created_at);
      item.put("completedAt", value.completed_at);
      if (value.paused.has_value()) item.put("paused", *value.paused);
      root.add_child(id, item);
    }
    write_json_atomic(data_directory_ / "tasks.json", root);
  }

  /** 将当前配置应用到 libtorrent Session。 */
  void apply_settings() {
    lt::settings_pack pack;
    pack.set_str(lt::settings_pack::listen_interfaces,
                 "0.0.0.0:" + std::to_string(settings_.listen_port) + ",[::]:" +
                     std::to_string(settings_.listen_port));
    pack.set_bool(lt::settings_pack::enable_dht, settings_.dht_enabled);
    pack.set_bool(lt::settings_pack::enable_lsd, settings_.dht_enabled);
    pack.set_bool(lt::settings_pack::enable_upnp, settings_.upnp_enabled);
    pack.set_bool(lt::settings_pack::enable_natpmp, settings_.upnp_enabled);
    pack.set_int(lt::settings_pack::active_downloads, settings_.max_active_downloads);
    pack.set_int(lt::settings_pack::active_limit, std::max(settings_.max_active_downloads + 2, 3));
    pack.set_int(lt::settings_pack::download_rate_limit, settings_.max_download_speed_kib * 1024);
    pack.set_int(lt::settings_pack::upload_rate_limit, settings_.max_upload_speed_kib * 1024);
    pack.set_int(lt::settings_pack::alert_mask,
                 lt::alert_category::error | lt::alert_category::storage |
                     lt::alert_category::status);
    session_.apply_settings(pack);
  }

  /** 更新运行配置并立即生效。 */
  pt::ptree configure(const pt::ptree& params) {
    settings_.listen_port = std::clamp(params.get<int>("listenPort", settings_.listen_port), 1024, 65535);
    settings_.dht_enabled = params.get<bool>("dhtEnabled", settings_.dht_enabled);
    settings_.upnp_enabled = params.get<bool>("upnpEnabled", settings_.upnp_enabled);
    settings_.max_active_downloads = std::max(1, params.get<int>("maxActiveDownloads", settings_.max_active_downloads));
    settings_.max_download_speed_kib = std::max(0, params.get<int>("maxDownloadSpeed", settings_.max_download_speed_kib));
    settings_.max_upload_speed_kib = std::max(0, params.get<int>("maxUploadSpeed", settings_.max_upload_speed_kib));
    settings_.seeding_limits_enabled = params.get<bool>("seedingLimits.enabled", false);
    settings_.ratio_limit_enabled = params.get<bool>("seedingLimits.ratioEnabled", false);
    settings_.ratio_limit = std::max(0.1, params.get<double>("seedingLimits.ratioLimit", 1.0));
    settings_.time_limit_enabled = params.get<bool>("seedingLimits.timeEnabled", false);
    settings_.time_limit_minutes = std::max(1, params.get<int>("seedingLimits.timeLimitMinutes", 120));
    apply_settings();
    return status();
  }

  /** 返回内核运行状态。 */
  pt::ptree status() const {
    pt::ptree result;
    result.put("version", ANI_TORRENT_CORE_VERSION);
    result.put("taskCount", session_.get_torrents().size());
    result.put("listenPort", settings_.listen_port);
    return result;
  }

  /** 添加 magnet 并返回真实 info hash 任务。 */
  pt::ptree add_magnet(const pt::ptree& params) {
    lt::error_code error;
    auto add = lt::parse_magnet_uri(params.get<std::string>("url"), error);
    if (error) throw std::runtime_error("磁链解析失败: " + error.message());
    return add_torrent(std::move(add), params);
  }

  /** 添加本地 torrent 文件并返回真实 info hash 任务。 */
  pt::ptree add_torrent_file(const pt::ptree& params) {
    lt::error_code error;
    auto info = std::make_shared<lt::torrent_info>(params.get<std::string>("filePath"), error);
    if (error) throw std::runtime_error("种子文件解析失败: " + error.message());
    lt::add_torrent_params add;
    add.ti = std::move(info);
    return add_torrent(std::move(add), params);
  }

  /** 统一添加任务、设置文件选择并保存关联信息。 */
  pt::ptree add_torrent(lt::add_torrent_params add, const pt::ptree& params) {
    add.save_path = params.get<std::string>("savePath");
    const bool paused = params.get<bool>("paused", false);
    if (paused) {
      add.flags |= lt::torrent_flags::paused;
      add.flags &= ~lt::torrent_flags::auto_managed;
    }
    lt::error_code error;
    auto handle = session_.add_torrent(std::move(add), error);
    if (error) throw std::runtime_error("添加任务失败: " + error.message());

    const auto selected = read_indexes(params, "selectedFileIndexes");
    if (!selected.empty() && handle.torrent_file()) {
      std::vector<lt::download_priority_t> priorities(
          static_cast<std::size_t>(handle.torrent_file()->num_files()), lt::dont_download);
      for (const int index : selected) {
        if (index >= 0 && index < static_cast<int>(priorities.size())) priorities[index] = lt::default_priority;
      }
      handle.prioritize_files(priorities);
    }

    const std::string id = task_id(handle);
    metadata_[id] = {
        params.get<std::string>("correlationTag", ""),
        now_iso(),
        "",
        paused};
    save_metadata();
    handle.save_resume_data(lt::torrent_handle::save_info_dict);
    return task_tree(handle);
  }

  /** 返回全部任务快照。 */
  pt::ptree list_tasks() {
    const auto handles = session_.get_torrents();
    pt::ptree result;
    result.add_child("tasks", map_array(handles, [this](const auto& handle) { return task_tree(handle); }));
    return result;
  }

  /** 返回指定任务快照。 */
  pt::ptree get_task(const pt::ptree& params) { return task_tree(require_handle(params)); }

  /** 返回指定任务的文件快照。 */
  pt::ptree get_files(const pt::ptree& params) {
    pt::ptree result;
    result.add_child("files", files_tree(require_handle(params)));
    return result;
  }

  /** 更新文件下载优先级并触发恢复数据保存。 */
  pt::ptree set_file_priority(const pt::ptree& params) {
    auto handle = require_handle(params);
    auto priorities = handle.get_file_priorities();
    const int priority = std::clamp(params.get<int>("priority"), 0, 7);
    for (const int index : read_indexes(params, "fileIndexes")) {
      if (index >= 0 && index < static_cast<int>(priorities.size())) {
        priorities[index] = lt::download_priority_t(static_cast<std::uint8_t>(priority));
      }
    }
    handle.prioritize_files(priorities);
    handle.save_resume_data(lt::torrent_handle::save_info_dict);
    pt::ptree result;
    result.put("updated", true);
    return result;
  }

  /** 暂停指定任务并保存恢复数据。 */
  pt::ptree pause(const pt::ptree& params) {
    auto handle = require_handle(params);
    const std::string id = task_id(handle);
    handle.unset_flags(lt::torrent_flags::auto_managed);
    handle.pause();
    metadata_[id].paused = true;
    save_metadata();
    handle.save_resume_data(lt::torrent_handle::save_info_dict);
    std::cerr << "[torrent-core] task paused task=" << id << '\n';
    pt::ptree result;
    result.put("paused", true);
    return result;
  }

  /** 恢复指定任务。 */
  pt::ptree resume(const pt::ptree& params) {
    auto handle = require_handle(params);
    const std::string id = task_id(handle);
    handle.set_flags(lt::torrent_flags::auto_managed);
    handle.resume();
    metadata_[id].paused = false;
    save_metadata();
    handle.save_resume_data(lt::torrent_handle::save_info_dict);
    std::cerr << "[torrent-core] task resumed task=" << id << '\n';
    pt::ptree result;
    result.put("resumed", true);
    return result;
  }

  /** 移除任务并按请求决定是否删除文件。 */
  pt::ptree remove(const pt::ptree& params) {
    auto handle = require_handle(params);
    const std::string id = task_id(handle);
    const bool delete_files = params.get<bool>("deleteFiles", false);
    session_.remove_torrent(handle, delete_files ? lt::session::delete_files : lt::remove_flags_t{});
    std::error_code ignored;
    fs::remove(resume_directory_ / (id + ".fastresume"), ignored);
    metadata_.erase(id);
    save_metadata();
    pt::ptree result;
    result.put("removed", true);
    return result;
  }

  /** 按任务标识查找 handle，不存在时抛出统一错误。 */
  lt::torrent_handle require_handle(const pt::ptree& params) const {
    const std::string id = params.get<std::string>("taskId");
    for (const auto& handle : session_.get_torrents()) {
      if (task_id(handle) == id) return handle;
    }
    throw TaskNotFoundError("内置下载任务不存在: " + id);
  }

  /** 将任务状态映射为 IPC JSON。 */
  pt::ptree task_tree(const lt::torrent_handle& handle) {
    const auto state = handle.status(
        lt::torrent_handle::query_name | lt::torrent_handle::query_save_path);
    const std::string id = task_id(handle);
    auto& metadata = metadata_[id];
    if (metadata.created_at.empty()) metadata.created_at = now_iso();
    if ((state.is_seeding || state.state == lt::torrent_status::finished) && metadata.completed_at.empty()) {
      metadata.completed_at = now_iso();
      save_metadata();
    }

    pt::ptree result;
    result.put("id", id);
    result.put("torrentHash", id);
    result.put("correlationTag", metadata.correlation_tag);
    result.put("name", state.name.empty() ? id : state.name);
    result.put("status", map_status(state, bool(handle.flags() & lt::torrent_flags::paused)));
    result.put("progress", static_cast<double>(state.progress_ppm) / 1'000'000.0);
    result.put("downloadSpeed", state.download_payload_rate);
    result.put("uploadSpeed", state.upload_payload_rate);
    result.put("totalSize", state.total_wanted);
    result.put("downloadedSize", state.total_wanted_done);
    const auto remaining = std::max<std::int64_t>(0, state.total_wanted - state.total_wanted_done);
    result.put("etaSeconds", state.download_payload_rate > 0 ? remaining / state.download_payload_rate : 0);
    result.put("savePath", state.save_path);
    result.put("createdAt", metadata.created_at);
    result.put("completedAt", metadata.completed_at);
    result.add_child("files", files_tree(handle));
    return result;
  }

  /** 将任务文件状态映射为 IPC JSON 数组。 */
  pt::ptree files_tree(const lt::torrent_handle& handle) const {
    pt::ptree files;
    const auto info = handle.torrent_file();
    if (!info) return files;
    const auto progress = handle.file_progress();
    const auto priorities = handle.get_file_priorities();
    const auto& storage = info->layout();
    for (int index = 0; index < storage.num_files(); ++index) {
      const auto file_index = lt::file_index_t(index);
      const auto size = storage.file_size(file_index);
      pt::ptree file;
      file.put("index", index);
      file.put("name", storage.file_path(file_index));
      file.put("size", size);
      file.put("progress", size > 0 ? static_cast<double>(progress[index]) / static_cast<double>(size) : 1.0);
      const int priority = index < static_cast<int>(priorities.size())
          ? static_cast<int>(static_cast<std::uint8_t>(priorities[index]))
          : 0;
      file.put("priority", priority);
      file.put("selected", priority > 0);
      files.push_back({"", file});
    }
    return files;
  }

  /** 处理恢复数据 alert 并写入对应文件。 */
  void process_alerts() {
    std::vector<lt::alert*> alerts;
    session_.pop_alerts(&alerts);
    for (const auto* alert : alerts) {
      if (const auto* saved = lt::alert_cast<lt::save_resume_data_alert>(alert)) {
        const std::string id = hash_hex(saved->params.info_hashes.get_best());
        write_binary_atomic(resume_directory_ / (id + ".fastresume"), lt::write_resume_data_buf(saved->params));
        if (pending_resume_saves_ > 0) --pending_resume_saves_;
      } else if (const auto* failed = lt::alert_cast<lt::save_resume_data_failed_alert>(alert)) {
        std::cerr << "[torrent-core] resume save failed task=" << task_id(failed->handle)
                  << " message=" << failed->error.message() << '\n';
        if (pending_resume_saves_ > 0) --pending_resume_saves_;
      } else if (const auto* torrent_error = lt::alert_cast<lt::torrent_error_alert>(alert)) {
        std::cerr << "[torrent-core] torrent error task=" << task_id(torrent_error->handle)
                  << " message=" << torrent_error->error.message() << '\n';
      }
    }
  }

  /** 请求所有任务生成恢复数据。 */
  void request_resume_save(bool force) {
    for (const auto& handle : session_.get_torrents()) {
      if (!force && !handle.need_save_resume_data()) continue;
      handle.save_resume_data(lt::torrent_handle::save_info_dict);
      ++pending_resume_saves_;
    }
  }

  /** 保存所有任务、Session 和元数据。 */
  void save_all_state(std::chrono::seconds timeout) {
    request_resume_save(true);
    const auto deadline = Clock::now() + timeout;
    while (pending_resume_saves_ > 0 && Clock::now() < deadline) {
      session_.wait_for_alert(std::chrono::milliseconds(100));
      process_alerts();
    }
    if (pending_resume_saves_ > 0) {
      std::cerr << "[torrent-core] resume save timeout pending=" << pending_resume_saves_ << '\n';
      pending_resume_saves_ = 0;
    }
    write_binary_atomic(data_directory_ / "session.state",
                        lt::write_session_params_buf(session_.session_state(), lt::save_state_flags_t::all()));
    save_metadata();
  }

  /** 达到分享率或做种时长阈值后暂停任务。 */
  void enforce_seeding_limits() {
    if (!settings_.seeding_limits_enabled) return;
    for (const auto& handle : session_.get_torrents()) {
      const auto state = handle.status();
      if (!state.is_seeding) continue;
      const std::string id = task_id(handle);
      auto& metadata = metadata_[id];
      if (metadata.completed_at.empty()) {
        metadata.completed_at = now_iso();
        save_metadata();
      }
      const double ratio = state.total_done > 0
          ? static_cast<double>(state.all_time_upload) / static_cast<double>(state.total_done)
          : 0.0;
      const auto completed = parse_time(metadata.completed_at);
      const auto seeded_minutes = std::chrono::duration_cast<std::chrono::minutes>(
          std::chrono::system_clock::now() - completed).count();
      const bool ratio_reached = settings_.ratio_limit_enabled && ratio >= settings_.ratio_limit;
      const bool time_reached = settings_.time_limit_enabled && seeded_minutes >= settings_.time_limit_minutes;
      if (ratio_reached || time_reached) {
        handle.unset_flags(lt::torrent_flags::auto_managed);
        handle.pause();
        metadata.paused = true;
        save_metadata();
        handle.save_resume_data(lt::torrent_handle::save_info_dict);
      }
    }
  }

  /** 解析核心生成的 UTC 时间；非法值按当前时间处理。 */
  std::chrono::system_clock::time_point parse_time(const std::string& value) const {
    std::tm utc{};
    std::istringstream input(value);
    input >> std::get_time(&utc, "%Y-%m-%dT%H:%M:%SZ");
    if (input.fail()) return std::chrono::system_clock::now();
#ifdef _WIN32
    return std::chrono::system_clock::from_time_t(_mkgmtime(&utc));
#else
    return std::chrono::system_clock::from_time_t(timegm(&utc));
#endif
  }

  fs::path data_directory_;
  fs::path resume_directory_;
  lt::session session_;
  CoreSettings settings_;
  std::map<std::string, TaskMetadata> metadata_;
  int pending_resume_saves_ = 0;
  Clock::time_point last_resume_save_ = Clock::now();
};

}  // namespace

namespace ani::torrent_core {

struct Runtime::Impl {
  explicit Impl(std::string data_directory) : core(fs::absolute(std::move(data_directory))) {}

  mutable std::mutex mutex;
  TorrentCore core;
  bool stop_requested = false;
  bool stopped = false;
};

Runtime::Runtime(std::string data_directory) : impl_(std::make_unique<Impl>(std::move(data_directory))) {}

Runtime::~Runtime() { shutdown(); }

std::string Runtime::execute(std::string_view request_json) {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  if (impl_->stopped) {
    return error_response("", "CORE_STOPPED", "内置下载核心已停止");
  }

  Command command;
  try {
    std::istringstream input{std::string(request_json)};
    pt::ptree request;
    pt::read_json(input, request);
    pt::ptree empty_params;
    command = {
        request.get<std::string>("id"),
        request.get<std::string>("method"),
        request.get_child("params", empty_params)};
  } catch (const std::exception& error) {
    return error_response("", "INVALID_REQUEST", error.what());
  }

  try {
    return success_response(command.id, impl_->core.execute(command, impl_->stop_requested));
  } catch (const TaskNotFoundError& error) {
    return error_response(command.id, "TASK_NOT_FOUND", error.what());
  } catch (const std::exception& error) {
    return error_response(command.id, "CORE_ERROR", error.what());
  }
}

void Runtime::tick() {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  if (!impl_->stopped) impl_->core.tick();
}

void Runtime::shutdown() {
  if (!impl_) return;
  std::lock_guard<std::mutex> lock(impl_->mutex);
  if (impl_->stopped) return;
  impl_->core.shutdown();
  impl_->stopped = true;
}

bool Runtime::should_stop() const {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  return impl_->stop_requested;
}

}  // namespace ani::torrent_core
