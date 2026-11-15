import SwiftUI

@main
struct TroveApp: App {
    @State private var app = AppModel()
    @AppStorage("appearance") private var appearance: Appearance = .system

    init() {
        ImagePipeline.shared.installMemoryWarningHandler()
        Task.detached(priority: .background) { await ImagePipeline.shared.trimDisk() }
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                .environment(app.library)
                .tint(.ember)
                .preferredColorScheme(appearance.colorScheme)
        }
    }
}

enum Appearance: String, CaseIterable, Identifiable {
    case system, light, dark
    var id: String { rawValue }
    var label: String { rawValue.capitalized }
    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        Group {
            switch app.phase {
            case .signedOut: LoginView()
            case .signedIn: MainView()
            }
        }
        .animation(.smooth(duration: 0.3), value: app.phase)
    }
}
