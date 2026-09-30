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

import AppKit

let executable = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
let name = executable.lastPathComponent
let contents = executable.deletingLastPathComponent().deletingLastPathComponent()
let bundle = contents.deletingLastPathComponent()
let electron = contents.appendingPathComponent("MacOS/\(name) Electron").path
let framework = contents.appendingPathComponent(
    "Frameworks/Electron Framework.framework/Versions/A/Electron Framework").path

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
