import SwiftUI

struct LoginView: View {
    @Environment(AppModel.self) private var app
    @State private var server = UserDefaults.standard.string(forKey: "lastServer") ?? AppModel.defaultServer
    @State private var secret = ""
    @State private var busy = false
    @State private var error: String?
    @State private var showServer = false
    @FocusState private var focus: Field?

    enum Field { case server, secret }

    var body: some View {
        ScrollView {
            VStack(spacing: 28) {
                Spacer(minLength: 40)
                VStack(spacing: 14) {
                    Image("AppIconImage")
                        .resizable()
                        .frame(width: 84, height: 84)
                        .clipShape(RoundedRectangle(cornerRadius: 19, style: .continuous))
                        .shadow(color: .black.opacity(0.12), radius: 12, y: 6)
                    Text("Trove")
                        .font(.largeTitle.bold())
                    Text("Save anything, keep everything.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }

                VStack(spacing: 12) {
                    if showServer {
                        field(icon: "server.rack") {
                            TextField("Server", text: $server)
                                .textContentType(.URL)
                                .keyboardType(.URL)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .focused($focus, equals: .server)
                                .submitLabel(.next)
                                .onSubmit { focus = .secret }
                        }
                    }
                    field(icon: "key.fill") {
                        SecureField("Password or API key", text: $secret)
                            .textContentType(.password)
                            .focused($focus, equals: .secret)
                            .submitLabel(.go)
                            .onSubmit(signIn)
                    }

                    if let error = error ?? app.notice {
                        Label(error, systemImage: "exclamationmark.circle.fill")
                            .font(.footnote)
                            .foregroundStyle(self.error != nil ? .red : .secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .transition(.opacity)
                    }

                    Button(action: signIn) {
                        ZStack {
                            Text("Sign In").opacity(busy ? 0 : 1)
                            if busy { ProgressView().tint(.white) }
                        }
                        .font(.headline)
                        .frame(maxWidth: .infinity, minHeight: 50)
                    }
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.roundedRectangle(radius: 14))
                    .disabled(secret.isEmpty || busy)
                    .padding(.top, 4)
                }
                .frame(maxWidth: 400)

                VStack(spacing: 8) {
                    if showServer {
                        Button("Use \(Fmt.host(AppModel.defaultServer))") {
                            withAnimation(.snappy) {
                                server = AppModel.defaultServer
                                showServer = false
                            }
                        }
                        .font(.footnote.weight(.medium))
                    } else {
                        HStack(spacing: 4) {
                            Text("Server: \(Fmt.host(server).isEmpty ? Fmt.host(AppModel.defaultServer) : Fmt.host(server))")
                                .foregroundStyle(.secondary)
                            Button("Change") {
                                withAnimation(.snappy) { showServer = true }
                                focus = .server
                            }
                            .fontWeight(.medium)
                        }
                        .font(.footnote)
                    }
                    Text("Use your Trove password, or an API key from Settings in the web app.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: 360)
                Spacer(minLength: 20)
            }
            .padding(.horizontal, 24)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Color(.systemGroupedBackground))
        .onAppear { focus = .secret }
        .task {
            // Debug-only: exercise the real sign-in path in the simulator.
            if let s = DevHooks.value("LOGIN") {
                server = DevHooks.value("LOGINSERVER") ?? server
                showServer = true
                secret = s
                try? await Task.sleep(for: .milliseconds(600))
                signIn()
            }
        }
    }

    private func field<F: View>(icon: String, @ViewBuilder _ content: () -> F) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .foregroundStyle(.secondary)
                .frame(width: 20)
            content()
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 52)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func signIn() {
        guard !secret.isEmpty, !busy else { return }
        busy = true
        error = nil
        Task {
            do {
                try await app.signIn(server: server, secret: secret)
            } catch {
                withAnimation { self.error = error.localizedDescription }
                busy = false
            }
        }
    }
}
