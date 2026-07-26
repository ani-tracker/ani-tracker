import AniTorrentCore
import Foundation
import Tauri
import UIKit

private let configureRequestKey = "ani_torrent_configure_request_v1"

private enum AniTorrentError: LocalizedError {
    case native(String)
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .native(let message): return message
        case .invalidResponse: return "下载核心返回无效响应"
        }
    }
}

/** 线程安全地持有并幂等结束 iOS 后台任务。 */
private final class BackgroundTaskLease: @unchecked Sendable {
    private let lock = NSLock()
    private var identifier = UIBackgroundTaskIdentifier.invalid
    private var ended = false

    /** 记录系统分配的任务标识；若已超时则立即结束。 */
    func activate(_ identifier: UIBackgroundTaskIdentifier) {
        lock.lock()
        if ended {
            lock.unlock()
            Self.endOnMain(identifier)
            return
        }
        self.identifier = identifier
        lock.unlock()
    }

    /** 幂等提取任务标识，并在主线程结束后台任务。 */
    func end() {
        lock.lock()
        guard !ended else {
            lock.unlock()
            return
        }
        ended = true
        let current = identifier
        identifier = .invalid
        lock.unlock()
        Self.endOnMain(current)
    }

    private static func endOnMain(_ identifier: UIBackgroundTaskIdentifier) {
        guard identifier != .invalid else { return }
        DispatchQueue.main.async {
            UIApplication.shared.endBackgroundTask(identifier)
        }
    }
}

private final class NativeTorrentSession {
    private var handle: OpaquePointer?

    /** 创建原生核心并恢复最近一次下载设置。 */
    init(dataDirectory: URL) throws {
        var errorPointer: UnsafeMutablePointer<CChar>?
        let created = dataDirectory.path.withCString {
            ani_torrent_core_start($0, &errorPointer)
        }
        guard let created else {
            throw AniTorrentError.native(Self.consumeError(&errorPointer))
        }
        handle = created
        do {
            if let request = UserDefaults.standard.string(forKey: configureRequestKey) {
                let response = try execute(request)
                guard Self.isSuccessful(response) else {
                    throw AniTorrentError.invalidResponse
                }
            }
        } catch {
            stop()
            throw error
        }
    }

    deinit {
        stop()
    }

    /** 执行完整 NDJSON 请求，并接管 C ABI 返回字符串。 */
    func execute(_ requestJson: String) throws -> String {
        guard let handle else {
            throw AniTorrentError.native("下载核心尚未启动")
        }
        var errorPointer: UnsafeMutablePointer<CChar>?
        let responsePointer = requestJson.withCString {
            ani_torrent_core_execute(handle, $0, &errorPointer)
        }
        guard let responsePointer else {
            throw AniTorrentError.native(Self.consumeError(&errorPointer))
        }
        defer { ani_torrent_core_string_free(responsePointer) }
        return String(cString: responsePointer)
    }

    /** 保存恢复数据并幂等释放原生 Session。 */
    func stop() {
        guard let handle else { return }
        ani_torrent_core_stop(handle)
        self.handle = nil
    }

    private static func consumeError(_ pointer: inout UnsafeMutablePointer<CChar>?) -> String {
        guard let current = pointer else { return "原生下载核心调用失败" }
        defer {
            ani_torrent_core_string_free(current)
            pointer = nil
        }
        return String(cString: current)
    }

    static func isSuccessful(_ response: String) -> Bool {
        guard
            let data = response.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return false }
        if let value = object["ok"] as? Bool { return value }
        if let value = object["ok"] as? String { return value == "true" }
        return false
    }
}

private struct ExecuteArgs: Decodable {
    let requestJson: String
}

/** 将 Tauri Rust transport 连接到 iOS 进程内 torrent-core。 */
final class AniTorrentPlugin: Plugin {
    private let queue = DispatchQueue(label: "com.ani.tracker.torrent")
    private var session: NativeTorrentSession?
    private var backgroundObserver: NSObjectProtocol?
    private var foregroundObserver: NSObjectProtocol?

    override init() {
        super.init()
        backgroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.flushForBackground()
        }
        foregroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.resumeAfterForeground()
        }
    }

    deinit {
        if let backgroundObserver { NotificationCenter.default.removeObserver(backgroundObserver) }
        if let foregroundObserver { NotificationCenter.default.removeObserver(foregroundObserver) }
        queue.sync { stopSession() }
    }

    /** 串行执行完整 NDJSON 请求，并保存最后一次有效配置。 */
    @objc public func execute(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(ExecuteArgs.self)
        queue.async { [weak self] in
            guard let self else { return }
            do {
                let response = try self.ensureSession().execute(args.requestJson)
                if self.requestMethod(args.requestJson) == "configure",
                   NativeTorrentSession.isSuccessful(response) {
                    UserDefaults.standard.set(args.requestJson, forKey: configureRequestKey)
                }
                invoke.resolve(["responseJson": response])
            } catch {
                NSLog("AniTorrentPlugin request failed: %@", error.localizedDescription)
                invoke.reject(
                    "iOS 下载核心请求失败",
                    code: "torrent_request_failed",
                    error: error
                )
            }
        }
    }

    /** 查询当前 iOS Session，不为状态读取隐式创建核心。 */
    @objc public func status(_ invoke: Invoke) {
        queue.async { [weak self] in
            guard let self else { return }
            do {
                let directory = try self.dataDirectory()
                invoke.resolve([
                    "running": self.session != nil,
                    "dataDirectory": directory.path,
                    "foregroundService": false
                ])
            } catch {
                invoke.reject(
                    "iOS 下载核心状态读取失败",
                    code: "torrent_status_failed",
                    error: error
                )
            }
        }
    }

    /** 保存恢复数据并结束当前 Session。 */
    @objc public func shutdown(_ invoke: Invoke) {
        queue.async { [weak self] in
            self?.stopSession()
            invoke.resolve(["stopped": true])
        }
    }

    /** 创建排除 iCloud 备份的核心数据目录。 */
    private func dataDirectory() throws -> URL {
        let base = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        )[0]
        var directory = base.appendingPathComponent("torrent-core", isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try directory.setResourceValues(values)
        return directory
    }

    private func ensureSession() throws -> NativeTorrentSession {
        if let session { return session }
        let created = try NativeTorrentSession(dataDirectory: dataDirectory())
        session = created
        NSLog("AniTorrentPlugin native core started")
        return created
    }

    private func stopSession() {
        guard let session else { return }
        session.stop()
        self.session = nil
        NSLog("AniTorrentPlugin native core stopped")
    }

    private func requestMethod(_ requestJson: String) -> String? {
        guard
            let data = requestJson.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return object["method"] as? String
    }

    /** iOS 进入后台时申请有限时间完成恢复数据刷盘。 */
    private func flushForBackground() {
        let lease = BackgroundTaskLease()
        let identifier = UIApplication.shared.beginBackgroundTask(withName: "AniTorrentFlush") {
            self.queue.async { [weak self] in
                self?.stopSession()
                lease.end()
            }
        }
        lease.activate(identifier)
        queue.async { [weak self] in
            self?.stopSession()
            lease.end()
        }
    }

    /** 返回前台后立即恢复 Session 和已持久化任务。 */
    private func resumeAfterForeground() {
        queue.async { [weak self] in
            do {
                _ = try self?.ensureSession()
            } catch {
                NSLog("AniTorrentPlugin foreground restore failed: %@", error.localizedDescription)
            }
        }
    }
}

@_cdecl("init_plugin_ani_torrent")
func initPlugin() -> Plugin {
    AniTorrentPlugin()
}
