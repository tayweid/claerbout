// A Claerbout app's entry point: the bundle's executable (APP.md, "Electron,
// one shell for Claerbout"). The app ships without Electron's framework, so
// every launch is the same: look for Electron; if it is there, become it;
// if not, find it (complete.sh: cloned from a sibling app, or downloaded)
// under a progress window, then become it.
//
// "Become" is execv: the process macOS launched turns into Electron, so it
// is the app to macOS throughout. That is why this is compiled rather than
// a script. Documents opened with the launch reach this process when it
// has to set up first, and it hands them to Electron as arguments, which
// the shell opens (main.js, filesIn); with Electron present it never
// starts AppKit, and they reach Electron directly. (A script cannot do
// this: any AppKit process a launch starts takes the launch's check-in, and
// the document is lost. Measured 2026-09-30.)
//
// Built by app/package.mjs with swiftc; Electron's own executable sits
// beside this one as "<name> Electron".
//
// Run with --claerbout-default-for, it does one thing more and never
// becomes Electron (below, "The default app for file types").

import AppKit
import UniformTypeIdentifiers

let executable = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
let name = executable.lastPathComponent
let contents = executable.deletingLastPathComponent().deletingLastPathComponent()
let bundle = contents.deletingLastPathComponent()
let electron = contents.appendingPathComponent("MacOS/\(name) Electron").path
let framework = contents.appendingPathComponent(
    "Frameworks/Electron Framework.framework/Versions/A/Electron Framework").path

// MARK: - The default app for file types

// The app menu's "Make <Name> the Default Editor…" (main.js, default-for.js)
// runs the bundle's executable as
//
//   <Name> --claerbout-default-for [--check] <extension>...
//
// and gets back, as JSON on stdout, each extension's type and the app that
// opens it now. Without --check it first makes this bundle the default for
// each of those types, as the Finder's Get Info › Open with › Change All
// does. Compiled, because a script cannot reach Launch Services' setter
// (JXA's $.LSCopyDefaultRoleHandlerForContentType comes back an untyped
// function), and the deprecated LSSetDefaultRoleHandlerForContentType
// answers noErr on macOS 26 and saves nothing. Since macOS 26.4 the
// system confirms each change in a prompt of its own, one type at a time,
// even for an app making itself the default ("Do you want all documents
// with the extension ".x" to open with A, or to keep using B?"; Get Info
// alone is spared it): so the menu passes only the types another app
// opens now, and a prompt declined comes back as that type's error.

struct Holder: Codable {
    let name: String
    let path: String
    let id: String?
    /// This app (by bundle identifier, so any copy of it).
    let own: Bool
}

struct Kind: Codable {
    let `extension`: String
    let type: String?
    /// The app that opens it now: after the setting, without --check.
    let holder: Holder?
    let error: String?
}

struct Report: Codable {
    let app: String
    let id: String?
    let kinds: [Kind]
}

func defaultFor(_ arguments: [String]) -> Never {
    let check = arguments.contains("--check")
    let extensions = arguments.filter { $0 != "--check" }
    guard !extensions.isEmpty else {
        fputs("\(name): --claerbout-default-for [--check] <extension>...\n", stderr)
        exit(2)
    }
    let ownID = Bundle(url: bundle)?.bundleIdentifier
    let types = extensions.map { UTType(filenameExtension: $0) }
    var errors: [String: String] = [:]

    func holder(_ type: UTType) -> Holder? {
        guard let app = NSWorkspace.shared.urlForApplication(toOpen: type) else { return nil }
        let id = Bundle(url: app)?.bundleIdentifier
        let own = id != nil ? id == ownID : app.standardizedFileURL == bundle.standardizedFileURL
        return Holder(name: FileManager.default.displayName(atPath: app.path), path: app.path, id: id, own: own)
    }

    func report() -> Never {
        let kinds = zip(extensions, types).map { ext, type -> Kind in
            guard let type else { return Kind(extension: ext, type: nil, holder: nil, error: "no type for .\(ext)") }
            return Kind(extension: ext, type: type.identifier, holder: holder(type), error: errors[type.identifier])
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = (try? encoder.encode(Report(app: bundle.path, id: ownID, kinds: kinds))) ?? Data("{}".utf8)
        FileHandle.standardOutput.write(data + Data("\n".utf8))
        exit(kinds.contains { $0.error != nil } ? 1 : 0)
    }

    if check { report() }
    // One type at a time (.yml and .yaml are one), in the order given, so
    // the prompts come one after another as the user answers them.
    var pending: [UTType] = []
    for type in types.compactMap({ $0 }) where !pending.contains(type) { pending.append(type) }
    func next() {
        guard !pending.isEmpty else { report() }
        let type = pending.removeFirst()
        NSWorkspace.shared.setDefaultApplication(at: bundle, toOpen: type) { error in
            DispatchQueue.main.async {
                if let error = error as NSError? {
                    errors[type.identifier] = "\(error.localizedDescription) (\(error.domain) \(error.code))"
                }
                next()
            }
        }
    }
    next()
    dispatchMain()
}

if let at = CommandLine.arguments.firstIndex(of: "--claerbout-default-for") {
    defaultFor(Array(CommandLine.arguments[(at + 1)...]))
}

func become(_ documents: [String] = []) -> Never {
    let args = [electron] + CommandLine.arguments.dropFirst() + documents
    var cargs = args.map { strdup($0) } + [nil]
    execv(electron, &cargs)
    fputs("\(name): could not start \(electron): \(String(cString: strerror(errno)))\n", stderr)
    exit(1)
}

// Electron is there: become it before AppKit is touched.
if FileManager.default.fileExists(atPath: framework) { become() }

func log(_ line: String) {
    let file = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs/\(name).log")
    let stamp = ISO8601DateFormatter().string(from: Date())
    guard let data = "[\(stamp)] \(name).app: \(line)\n".data(using: .utf8) else { return }
    if let handle = try? FileHandle(forWritingTo: file) {
        handle.seekToEndOfFile()
        handle.write(data)
        handle.closeFile()
    } else {
        try? data.write(to: file)
    }
}

final class Setup: NSObject, NSApplicationDelegate {
    private var documents: [String] = []
    private var window: NSWindow?
    private let label = NSTextField(labelWithString: "One moment…")
    private let bar = NSProgressIndicator()
    private let status = FileManager.default.temporaryDirectory
        .appendingPathComponent("\(name)-setup-\(ProcessInfo.processInfo.processIdentifier)")
    private var shown = ""

    func application(_ application: NSApplication, open urls: [URL]) {
        documents += urls.filter(\.isFileURL).map(\.path)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.activate(ignoringOtherApps: true)
        // Opened where it was downloaded, macOS runs the app from a
        // read-only copy (App Translocation), which cannot be completed.
        if bundle.path.contains("/AppTranslocation/") {
            alert("Move \(name) to Applications",
                  "Drag \(name) from your Downloads folder into Applications, then open it from there.")
            exit(0)
        }
        if !FileManager.default.isWritableFile(atPath: contents.appendingPathComponent("Frameworks").path) {
            alert("\(name) cannot finish setting itself up",
                  "It needs to write inside \(bundle.path). Move it to your Applications folder and open it again.")
            exit(1)
        }
        showWindow()
        log("completing \(bundle.path)")
        FileManager.default.createFile(atPath: status.path, contents: nil)
        let task = Process()
        task.executableURL = contents.appendingPathComponent("Resources/complete.sh")
        task.arguments = [bundle.path, status.path]
        let output = Pipe()
        task.standardOutput = output
        task.standardError = output
        let timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in self?.follow() }
        task.terminationHandler = { finished in
            let text = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            DispatchQueue.main.async { self.finished(finished.terminationStatus, text, timer) }
        }
        do {
            try task.run()
        } catch {
            finished(1, "complete.sh could not run: \(error.localizedDescription)", timer)
        }
    }

    private func finished(_ code: Int32, _ output: String, _ timer: Timer) {
        timer.invalidate()
        try? FileManager.default.removeItem(at: status)
        let text = output.trimmingCharacters(in: .whitespacesAndNewlines)
        log(text.isEmpty ? "complete.sh exited \(code)" : text)
        guard code == 0 else {
            window?.orderOut(nil)
            let reason = text.split(separator: "\n").last.map(String.init)?
                .replacingOccurrences(of: "complete.sh: ", with: "") ?? "complete.sh exited \(code)"
            alert("\(name) could not finish setting itself up", "\(reason)\n\nCheck the connection and open \(name) again.")
            exit(1)
        }
        become(documents)
    }

    /// The status file's last "percent|text" line (complete.sh).
    private func follow() {
        guard let text = try? String(contentsOf: status, encoding: .utf8),
              let last = text.split(separator: "\n").last.map(String.init), last != shown,
              let cut = last.firstIndex(of: "|")
        else { return }
        shown = last
        label.stringValue = String(last[last.index(after: cut)...])
        if let percent = Double(last[..<cut]) {
            bar.isIndeterminate = false
            bar.doubleValue = percent
        } else {
            bar.isIndeterminate = true
            bar.startAnimation(nil)
        }
    }

    private func showWindow() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 440, height: 132),
            styleMask: [.titled], backing: .buffered, defer: false)
        window.title = name
        let view = window.contentView!
        let icon = NSImageView(image: NSApp.applicationIconImage)
        icon.frame = NSRect(x: 20, y: 36, width: 64, height: 64)
        view.addSubview(icon)
        let heading = NSTextField(labelWithString: "Getting \(name) ready")
        heading.font = .boldSystemFont(ofSize: 13)
        heading.frame = NSRect(x: 100, y: 84, width: 320, height: 20)
        view.addSubview(heading)
        label.frame = NSRect(x: 100, y: 60, width: 320, height: 20)
        label.textColor = .secondaryLabelColor
        view.addSubview(label)
        bar.frame = NSRect(x: 100, y: 32, width: 320, height: 20)
        bar.minValue = 0
        bar.maxValue = 100
        bar.isIndeterminate = true
        bar.startAnimation(nil)
        view.addSubview(bar)
        window.center()
        window.makeKeyAndOrderFront(nil)
        self.window = window
    }

    private func alert(_ message: String, _ detail: String) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = message
        alert.informativeText = detail
        alert.runModal()
    }
}

let app = NSApplication.shared
let setup = Setup()
app.delegate = setup
app.setActivationPolicy(.regular)
app.run()
