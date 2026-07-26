import BackgroundTasks
import Foundation
import Network
import Security
import Tauri
import UIKit
import UserNotifications

private let backgroundRefreshIdentifier = "com.ani.tracker.refresh"
private let backgroundRefreshDueKey = "ani_background_refresh_due_v1"
private let keychainService = "com.ani.tracker.secure-store.v1"

private enum AniMobileError: LocalizedError {
    case invalidArgument(String)
    case keychain(OSStatus)
    case file(String)

    var errorDescription: String? {
        switch self {
        case .invalidArgument(let message), .file(let message):
            return message
        case .keychain(let status):
            return SecCopyErrorMessageString(status, nil) as String? ?? "Keychain 操作失败：\(status)"
        }
    }
}

private struct SecureKeyArgs: Decodable {
    let key: String
}

private struct SecureValueArgs: Decodable {
    let key: String
    let value: String
}

private struct ImportDocumentArgs: Decodable {
    let uri: String
    let kind: String
}

private struct ExportDocumentArgs: Decodable {
    let uri: String
    let sourcePath: String
}

/** 幂等完成 iOS BGTask，避免正常完成和超时回调重复提交。 */
private final class BackgroundTaskCompletion: @unchecked Sendable {
    private let lock = NSLock()
    private var completed = false

    /** 首次调用时向系统提交任务结果。 */
    func complete(_ task: BGTask, success: Bool) {
        lock.lock()
        guard !completed else {
            lock.unlock()
            return
        }
        completed = true
        lock.unlock()
        task.setTaskCompleted(success: success)
    }
}

/** 提供 iOS 生命周期、运行约束、Keychain 和安全作用域文档访问。 */
final class AniMobilePlugin: Plugin {
    private static let registrationLock = NSLock()
    private static var backgroundTaskRegistered = false

    private let stateLock = NSLock()
    private let pathMonitor = NWPathMonitor()
    private let pathMonitorQueue = DispatchQueue(label: "com.ani.tracker.mobile.network")
    private var lifecycle = "foreground"
    private var network = "unknown"
    private var metered = false
    private var pendingNavigation: String?
    private var observers: [NSObjectProtocol] = []

    override init() {
        super.init()
        lifecycle = currentLifecycle()
        observeLifecycle()
        startNetworkMonitor()
        registerBackgroundRefresh()
        scheduleBackgroundRefresh()
        NSLog("AniMobilePlugin iOS platform plugin loaded")
    }

    deinit {
        pathMonitor.cancel()
        observers.forEach { NotificationCenter.default.removeObserver($0) }
    }

    /** 返回生命周期、网络、存储、方向和通知权限的确定状态。 */
    @objc public func status(_ invoke: Invoke) {
        let resource = resourceSnapshot()
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            invoke.resolve([
                "lifecycle": resource.lifecycle,
                "network": resource.network,
                "metered": resource.metered,
                "storage": resource.storage,
                "availableBytes": resource.availableBytes,
                "orientation": resource.orientation,
                "notificationPermission": Self.notificationPermission(settings.authorizationStatus)
            ])
        }
    }

    /** 原子读取并清除最近一次原生导航意图。 */
    @objc public func consumeNavigation(_ invoke: Invoke) {
        stateLock.lock()
        let pageId = pendingNavigation
        pendingNavigation = nil
        stateLock.unlock()
        if let pageId {
            invoke.resolve(["pageId": pageId])
        } else {
            invoke.resolve()
        }
    }

    /** 原子读取并清除 BGTask 写入的前台补跑标记。 */
    @objc public func consumeBackgroundRefresh(_ invoke: Invoke) {
        let defaults = UserDefaults.standard
        let due = defaults.object(forKey: backgroundRefreshDueKey) != nil
        if due { defaults.removeObject(forKey: backgroundRefreshDueKey) }
        invoke.resolve(["due": due])
    }

    /** 将 UTF-8 敏感值写入仅本设备可用的 Keychain。 */
    @objc public func secureSet(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(SecureValueArgs.self)
        do {
            try validateKey(args.key)
            try KeychainStore.set(key: args.key, value: args.value)
            NSLog("AniMobilePlugin secure value stored: %@", args.key)
            invoke.resolve()
        } catch {
            invoke.reject("iOS 安全存储写入失败", code: "secure_store_failed", error: error)
        }
    }

    /** 从 Keychain 读取并解码 UTF-8 敏感值。 */
    @objc public func secureGet(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(SecureKeyArgs.self)
        do {
            try validateKey(args.key)
            if let value = try KeychainStore.get(key: args.key) {
                invoke.resolve(["value": value])
            } else {
                invoke.resolve([String: Any]())
            }
        } catch {
            invoke.reject("iOS 安全存储读取失败", code: "secure_read_failed", error: error)
        }
    }

    /** 删除 Keychain 中的指定敏感值。 */
    @objc public func secureDelete(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(SecureKeyArgs.self)
        do {
            try validateKey(args.key)
            try KeychainStore.delete(key: args.key)
            NSLog("AniMobilePlugin secure value deleted: %@", args.key)
            invoke.resolve()
        } catch {
            invoke.reject("iOS 安全存储删除失败", code: "secure_delete_failed", error: error)
        }
    }

    /** 将用户选择的安全作用域文档复制到应用私有缓存。 */
    @objc public func importDocument(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(ImportDocumentArgs.self)
        do {
            let source = try fileURL(args.uri)
            let (extensionName, limit) = try documentPolicy(args.kind)
            let directory = FileManager.default.temporaryDirectory
                .appendingPathComponent("ani-document-imports", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let target = directory.appendingPathComponent("\(args.kind)-\(UUID().uuidString)\(extensionName)")
            try withSecurityScopedAccess(source) {
                try copyFile(from: source, to: target, limit: limit)
            }
            NSLog("AniMobilePlugin document imported kind=%@", args.kind)
            invoke.resolve(["path": target.path])
        } catch {
            invoke.reject("iOS 文档导入失败", code: "document_import_failed", error: error)
        }
    }

    /** 将应用私有备份写入用户选择的安全作用域文档。 */
    @objc public func exportDocument(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(ExportDocumentArgs.self)
        do {
            let source = URL(fileURLWithPath: args.sourcePath).standardizedFileURL
            guard isPrivateFile(source) else {
                throw AniMobileError.file("仅允许导出应用私有文件")
            }
            let target = try fileURL(args.uri)
            try withSecurityScopedAccess(target) {
                try copyFile(from: source, to: target, limit: 2 * 1024 * 1024 * 1024)
            }
            NSLog("AniMobilePlugin document exported")
            invoke.resolve()
        } catch {
            invoke.reject("iOS 文档导出失败", code: "document_export_failed", error: error)
        }
    }

    /** 注册前后台生命周期监听，并将状态归一化。 */
    private func observeLifecycle() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.setLifecycle("background")
            self?.scheduleBackgroundRefresh()
        })
        observers.append(center.addObserver(
            forName: UIApplication.willResignActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in self?.setLifecycle("inactive") })
        observers.append(center.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in self?.setLifecycle("foreground") })
    }

    /** 监听系统网络路径，并记录受限或计费网络。 */
    private func startNetworkMonitor() {
        pathMonitor.pathUpdateHandler = { [weak self] path in
            let state: String
            switch path.status {
            case .satisfied: state = "online"
            case .requiresConnection: state = "limited"
            case .unsatisfied: state = "offline"
            @unknown default: state = "unknown"
            }
            self?.stateLock.lock()
            self?.network = state
            self?.metered = path.isExpensive || path.isConstrained
            self?.stateLock.unlock()
        }
        pathMonitor.start(queue: pathMonitorQueue)
    }

    /** 注册 iOS BGAppRefreshTask，系统挂起时只记录补跑标记。 */
    private func registerBackgroundRefresh() {
        Self.registrationLock.lock()
        guard !Self.backgroundTaskRegistered else {
            Self.registrationLock.unlock()
            return
        }
        Self.backgroundTaskRegistered = true
        Self.registrationLock.unlock()
        let registered = BGTaskScheduler.shared.register(
            forTaskWithIdentifier: backgroundRefreshIdentifier,
            using: nil
        ) { [weak self] task in
            guard let self, let refreshTask = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            self.handleBackgroundRefresh(refreshTask)
        }
        if !registered {
            NSLog("AniMobilePlugin background refresh registration rejected")
        }
    }

    /** 申请下一次系统允许的后台刷新，不承诺精确执行时间。 */
    private func scheduleBackgroundRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: backgroundRefreshIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            NSLog("AniMobilePlugin background refresh schedule failed: %@", error.localizedDescription)
        }
    }

    /** 后台刷新到期时写入补跑标记，前台 Rust 调度器负责执行完整扫描。 */
    private func handleBackgroundRefresh(_ task: BGAppRefreshTask) {
        let completion = BackgroundTaskCompletion()
        task.expirationHandler = { completion.complete(task, success: false) }
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: backgroundRefreshDueKey)
        scheduleBackgroundRefresh()
        completion.complete(task, success: true)
        NSLog("AniMobilePlugin background refresh marked for foreground catch-up")
    }

    /** 返回锁保护的生命周期、网络与当前资源状态。 */
    private func resourceSnapshot() -> (
        lifecycle: String,
        network: String,
        metered: Bool,
        storage: String,
        availableBytes: Int64,
        orientation: String
    ) {
        stateLock.lock()
        let lifecycleValue = lifecycle
        let networkValue = network
        let meteredValue = metered
        stateLock.unlock()
        let availableBytes = availableStorageBytes()
        let storage = availableBytes.map {
            $0 < 256 * 1024 * 1024
                ? "critical"
                : $0 < 1024 * 1024 * 1024 ? "low" : "ok"
        } ?? "unknown"
        return (
            lifecycleValue,
            networkValue,
            meteredValue,
            storage,
            availableBytes ?? 0,
            currentOrientation()
        )
    }

    /** 在主线程读取 UIApplication 生命周期。 */
    private func currentLifecycle() -> String {
        onMainThread {
            switch UIApplication.shared.applicationState {
            case .active: return "foreground"
            case .inactive: return "inactive"
            case .background: return "background"
            @unknown default: return "inactive"
            }
        }
    }

    /** 返回当前活动 UIWindowScene 的界面方向。 */
    private func currentOrientation() -> String {
        onMainThread {
            let orientation = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .first(where: { $0.activationState != .unattached })?
                .interfaceOrientation
            switch orientation {
            case .portrait, .portraitUpsideDown: return "portrait"
            case .landscapeLeft, .landscapeRight: return "landscape"
            default: return "unknown"
            }
        }
    }

    /** 返回应用数据卷的重要用途可用空间。 */
    private func availableStorageBytes() -> Int64? {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return (try? base.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]))
            ?.volumeAvailableCapacityForImportantUsage
    }

    /** 线程安全更新生命周期。 */
    private func setLifecycle(_ value: String) {
        stateLock.lock()
        lifecycle = value
        stateLock.unlock()
    }

    /** 校验安全存储键名长度与字符范围。 */
    private func validateKey(_ key: String) throws {
        guard key.count <= 128,
              key.range(of: "^[A-Za-z0-9._-]{1,128}$", options: .regularExpression) != nil else {
            throw AniMobileError.invalidArgument("安全存储 key 无效")
        }
    }

    /** 将 URI 或绝对路径解析为本地文件 URL。 */
    private func fileURL(_ value: String) throws -> URL {
        if let url = URL(string: value), url.isFileURL {
            return url.standardizedFileURL
        }
        guard value.hasPrefix("/") else {
            throw AniMobileError.invalidArgument("仅允许本地系统文档")
        }
        return URL(fileURLWithPath: value).standardizedFileURL
    }

    /** 返回文档扩展名和最大大小限制。 */
    private func documentPolicy(_ kind: String) throws -> (String, Int64) {
        switch kind {
        case "torrent": return (".torrent", 32 * 1024 * 1024)
        case "backup": return (".sqlite", 2 * 1024 * 1024 * 1024)
        default: throw AniMobileError.invalidArgument("文档类型不受支持")
        }
    }

    /** 在安全作用域授权有效期间执行文件操作。 */
    private func withSecurityScopedAccess<T>(_ url: URL, operation: () throws -> T) throws -> T {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        return try operation()
    }

    /** 使用固定缓冲复制文件并限制总大小。 */
    private func copyFile(from source: URL, to target: URL, limit: Int64) throws {
        let attributes = try FileManager.default.attributesOfItem(atPath: source.path)
        let size = (attributes[.size] as? NSNumber)?.int64Value ?? 0
        guard size <= limit else { throw AniMobileError.file("文档超过大小限制") }
        FileManager.default.createFile(atPath: target.path, contents: nil)
        let input = try FileHandle(forReadingFrom: source)
        let output = try FileHandle(forWritingTo: target)
        defer {
            try? input.close()
            try? output.close()
        }
        try output.truncate(atOffset: 0)
        var copied: Int64 = 0
        while true {
            let data = input.readData(ofLength: 64 * 1024)
            if data.isEmpty { break }
            copied += Int64(data.count)
            guard copied <= limit else {
                try? FileManager.default.removeItem(at: target)
                throw AniMobileError.file("文档超过大小限制")
            }
            output.write(data)
        }
        output.synchronizeFile()
    }

    /** 判断待导出文件是否位于当前应用沙箱。 */
    private func isPrivateFile(_ url: URL) -> Bool {
        let roots = [
            FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0],
            FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0],
            FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0],
            FileManager.default.temporaryDirectory
        ].map { $0.standardizedFileURL.path + "/" }
        let path = url.standardizedFileURL.path
        return roots.contains { path.hasPrefix($0) }
    }

    /** 将闭包同步派发到主线程并返回结果。 */
    private func onMainThread<T>(_ operation: () -> T) -> T {
        if Thread.isMainThread { return operation() }
        return DispatchQueue.main.sync(execute: operation)
    }

    /** 将通知授权枚举映射为稳定字符串。 */
    private static func notificationPermission(_ status: UNAuthorizationStatus) -> String {
        if #available(iOS 14.0, *), status == .ephemeral { return "granted" }
        switch status {
        case .authorized, .provisional: return "granted"
        case .denied: return "denied"
        case .notDetermined: return "prompt"
        @unknown default: return "prompt"
        }
    }
}

/** 使用 Generic Password 项实现不可同步的 iOS Keychain 存储。 */
private enum KeychainStore {
    /** 写入或更新敏感值。 */
    static func set(key: String, value: String) throws {
        let data = Data(value.utf8)
        let query = baseQuery(key: key)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        let updated = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updated == errSecSuccess { return }
        guard updated == errSecItemNotFound else { throw AniMobileError.keychain(updated) }
        var insert = query
        attributes.forEach { insert[$0.key] = $0.value }
        let added = SecItemAdd(insert as CFDictionary, nil)
        guard added == errSecSuccess else { throw AniMobileError.keychain(added) }
    }

    /** 读取 UTF-8 敏感值。 */
    static func get(key: String) throws -> String? {
        var query = baseQuery(key: key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else {
            if status != errSecSuccess { throw AniMobileError.keychain(status) }
            throw AniMobileError.file("Keychain 值不是 UTF-8")
        }
        return value
    }

    /** 删除敏感值；不存在时视为成功。 */
    static func delete(key: String) throws {
        let status = SecItemDelete(baseQuery(key: key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw AniMobileError.keychain(status)
        }
    }

    /** 创建关闭 iCloud 同步的稳定 Keychain 查询。 */
    private static func baseQuery(key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: key,
            kSecAttrSynchronizable as String: kCFBooleanFalse as Any
        ]
    }
}

@_cdecl("init_plugin_ani_mobile")
func initPlugin() -> Plugin {
    AniMobilePlugin()
}
