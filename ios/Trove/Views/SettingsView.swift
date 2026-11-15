import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(Library.self) private var library
    @Environment(\.dismiss) private var dismiss
    @AppStorage("appearance") private var appearance: Appearance = .system
    @AppStorage("readerSize") private var readerSize: Double = 18
    @AppStorage("readerSerif") private var readerSerif = true
    @AppStorage("markReadAtEnd") private var markReadAtEnd = true
    @AppStorage("openLinksInApp") private var openLinksInApp = true
    @State private var cacheSize: Int?
    @State private var me: MeInfo?
    @State private var confirmSignOut = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Account") {
                    LabeledContent("Server", value: app.serverHost)
                    LabeledContent("Signed in with") {
                        Text(app.account?.credential.isKey == true ? "API key\(app.account?.keyName.map { " “\($0)”" } ?? "")" : "Password")
                    }
                    if let s = library.stats {
                        LabeledContent("Library", value: "\(s.total.formatted()) items")
                    }
                    Button("Sign Out", role: .destructive) { confirmSignOut = true }
                }

                Section {
                    Stepper(value: $readerSize, in: 14...28, step: 1) {
                        LabeledContent("Text size", value: "\(Int(readerSize)) pt")
                    }
                    Toggle("Serif font", isOn: $readerSerif)
                    Toggle("Mark as read when finished", isOn: $markReadAtEnd)
                    Toggle("Open links inside Trove", isOn: $openLinksInApp)
                } header: {
                    Text("Reading")
                } footer: {
                    Text("Reading position syncs with the web app.")
                }

                Section("Appearance") {
                    Picker("Theme", selection: $appearance) {
                        ForEach(Appearance.allCases) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.segmented)
                }

                Section {
                    LabeledContent("Image cache", value: cacheSize.map { ByteCountFormatter.string(fromByteCount: Int64($0), countStyle: .file) } ?? "…")
                    Button("Clear Cache") {
                        Task {
                            await ImagePipeline.shared.clearDisk()
                            await DiskCache.clear()
                            cacheSize = await ImagePipeline.shared.diskUsage()
                            library.show(Toast(text: "Cache cleared", systemImage: "trash"))
                        }
                    }
                } header: {
                    Text("Storage")
                } footer: {
                    Text("Covers and pages are cached on this device so the app opens instantly and uses less data.")
                }

                Section("Trove") {
                    if let url = app.account?.baseURL {
                        Link(destination: url) { Label("Open the web app", systemImage: "safari") }
                    }
                    if let notion = me?.notion?.library.flatMap(URL.init(string:)) {
                        Link(destination: notion) { Label("Library in Notion", systemImage: "arrow.up.forward.app") }
                    }
                    if let bot = me?.telegram?.bot, let tg = URL(string: "https://t.me/\(bot)") {
                        Link(destination: tg) { Label("Telegram bot", systemImage: "paperplane") }
                    }
                    if let address = me?.email?.address {
                        LabeledContent { Text(address).textSelection(.enabled) } label: { Label("Email to Trove", systemImage: "envelope") }
                    }
                    LabeledContent("Version", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.fontWeight(.semibold) } }
            .task {
                cacheSize = await ImagePipeline.shared.diskUsage()
                me = try? await library.api?.me()
            }
            .confirmationDialog("Sign out of Trove?", isPresented: $confirmSignOut, titleVisibility: .visible) {
                Button("Sign Out", role: .destructive) {
                    dismiss()
                    app.signOut()
                }
            } message: {
                Text("Your library stays on the server. You can sign in again any time.")
            }
        }
    }
}
