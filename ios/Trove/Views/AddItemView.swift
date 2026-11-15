import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Save a link, several links, a note, photos or files.
struct AddItemView: View {
    var initialText = ""
    @Environment(Library.self) private var library
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss

    @State private var text = ""
    @State private var collection: String?
    @State private var tags: [String] = []
    @State private var note = ""
    @State private var favorite = false
    @State private var files: [UploadFile] = []
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var importing = false
    @State private var preparing = 0
    @State private var saving = false
    @State private var progress: [UUID: Double] = [:]
    @State private var error: String?
    @FocusState private var focused: Bool

    private var links: [String] {
        text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    private var allLinks: Bool {
        let l = links
        return !l.isEmpty && l.allSatisfy { ($0.hasPrefix("http://") || $0.hasPrefix("https://")) && !$0.contains(" ") }
    }

    private var canSave: Bool { (!links.isEmpty || !files.isEmpty) && !saving && preparing == 0 }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Paste a link or write a note", text: $text, axis: .vertical)
                        .lineLimit(3...12)
                        .focused($focused)
                        .textInputAutocapitalization(.sentences)
                    if text.isEmpty {
                        PasteButton(payloadType: String.self) { strings in
                            Task { @MainActor in text = strings.joined(separator: "\n") }
                        }
                        .buttonBorderShape(.capsule)
                        .labelStyle(.titleAndIcon)
                    }
                } footer: {
                    if allLinks, links.count > 1 {
                        Text("\(links.count) links will be saved.")
                    } else if !text.isEmpty, !allLinks {
                        Text("Saved as a note. A message with one link saves that link.")
                    }
                }

                Section {
                    ForEach(files) { file in fileRow(file) }
                    if preparing > 0 {
                        HStack { ProgressView(); Text("Preparing…").foregroundStyle(.secondary) }
                    }
                    PhotosPicker(selection: $photoItems, maxSelectionCount: 10, matching: .any(of: [.images, .videos]), photoLibrary: .shared()) {
                        Label("Add Photos or Videos", systemImage: "photo.on.rectangle")
                    }
                    Button { importing = true } label: { Label("Add Files", systemImage: "doc.badge.plus") }
                } header: {
                    Text("Files")
                } footer: {
                    if !files.isEmpty { Text("Images and PDFs are read with OCR so their text is searchable.") }
                }

                Section {
                    NavigationLink {
                        CollectionPicker(selection: $collection, allowsNone: true, noneLabel: "Automatic")
                    } label: {
                        LabeledContent {
                            Text(collection.map { $0.replacingOccurrences(of: "/", with: " › ") } ?? "Automatic")
                        } label: {
                            Label("Collection", systemImage: "folder")
                        }
                    }
                    TagField(tags: $tags, suggestions: library.tagNames)
                } footer: {
                    if collection == nil { Text("Trove files it into the right collection and adds tags for you.") }
                }

                Section {
                    TextField("Note", text: $note, axis: .vertical)
                        .lineLimit(1...6)
                    Toggle(isOn: $favorite) { Label("Favorite", systemImage: "heart") }
                }

                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Save to Trove")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        files.forEach { $0.discard() }
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if saving {
                        ProgressView()
                    } else {
                        Button("Save", action: save)
                            .fontWeight(.semibold)
                            .disabled(!canSave)
                    }
                }
            }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
                guard case .success(let urls) = result else { return }
                for url in urls {
                    if let f = try? UploadFile.stage(from: url) { files.append(f) }
                }
            }
            .onChange(of: photoItems) { _, items in
                guard !items.isEmpty else { return }
                photoItems = []
                Task { await stagePhotos(items) }
            }
            .interactiveDismissDisabled(saving)
            .onAppear {
                if text.isEmpty { text = initialText }
                focused = initialText.isEmpty
            }
            .task {
                // Debug-only: save straight away to check the save flow in the simulator.
                if DevHooks.value("AUTOSAVE") != nil, !text.isEmpty {
                    try? await Task.sleep(for: .seconds(1.5))
                    save()
                }
            }
        }
    }

    private func fileRow(_ file: UploadFile) -> some View {
        HStack(spacing: 12) {
            Group {
                if let thumb = file.thumbnail {
                    Image(uiImage: thumb).resizable().aspectRatio(contentMode: .fill)
                } else {
                    Image(systemName: file.isVideo ? "film" : "doc.fill")
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(Color(.tertiarySystemFill))
                }
            }
            .frame(width: 44, height: 44)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            VStack(alignment: .leading, spacing: 3) {
                Text(file.filename).lineLimit(1)
                if let p = progress[file.id] {
                    ProgressView(value: p).tint(.accentColor)
                } else {
                    Text(ByteCountFormatter.string(fromByteCount: file.size, countStyle: .file))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            if !saving {
                Button {
                    file.discard()
                    files.removeAll { $0.id == file.id }
                } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Remove \(file.filename)")
            }
        }
    }

    private func stagePhotos(_ items: [PhotosPickerItem]) async {
        for item in items {
            preparing += 1
            defer { preparing -= 1 }
            let isVideo = item.supportedContentTypes.contains { $0.conforms(to: .movie) }
            if isVideo, let movie = try? await item.loadTransferable(type: PickedMovie.self) {
                files.append(movie.file)
            } else if let data = try? await item.loadTransferable(type: Data.self) {
                let name = "Photo \(Date.now.formatted(.dateTime.year().month().day().hour().minute().second())).jpg".replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: ".")
                if let f = try? UploadFile.stage(imageData: data, suggestedName: name) { files.append(f) }
            }
        }
    }

    // MARK: Save

    private var commonFields: [String: JSONValue] {
        var b: [String: JSONValue] = ["source": "iOS app"]
        if !tags.isEmpty { b["tags"] = .strings(tags) }
        if let collection { b["collection"] = .string(collection) }
        if !note.trimmingCharacters(in: .whitespaces).isEmpty { b["note"] = .string(note) }
        if favorite { b["favorite"] = true }
        if library.api?.account.credential.isKey == false { b["via"] = .string(UIDevice.current.model) }
        return b
    }

    private func save() {
        guard let api = library.api else { return }
        saving = true
        error = nil
        Task { await performSave(api) }
    }

    private func performSave(_ api: APIClient) async {
        let fields = commonFields
        let lines = links
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        var saved: [Item] = []
        var failures: [String] = []
        do {
            if allLinks && lines.count > 1 {
                let bodies: [[String: JSONValue]] = lines.map { line in
                    var b = fields
                    b["url"] = .string(line)
                    return b
                }
                let r = try await api.saveMany(bodies)
                for entry in r.results {
                    if let item = entry.item {
                        library.didSave(item, created: entry.created ?? true)
                        saved.append(item)
                    }
                    if let e = entry.error { failures.append(e) }
                }
            } else if !body.isEmpty {
                var b = fields
                b[allLinks ? "url" : "text"] = .string(body)
                let r = try await api.save(b)
                library.didSave(r.item, created: r.created ?? true)
                saved.append(r.item)
            }
        } catch {
            failures.append(error.localizedDescription)
        }

        let fileFields = Self.formFields(fields)
        for file in files {
            let id = file.id
            progress[id] = 0
            do {
                let r = try await api.upload(file, fields: fileFields) { p in
                    Task { @MainActor in progress[id] = p }
                }
                library.didSave(r.item, created: r.created ?? true)
                saved.append(r.item)
                file.discard()
                files.removeAll { $0.id == id }
            } catch {
                progress[id] = nil
                failures.append("\(file.filename): \(error.localizedDescription)")
            }
        }
        saving = false
        guard failures.isEmpty else {
            if !saved.isEmpty { text = "" }
            error = failures.joined(separator: "\n")
            return
        }
        announce(saved)
        dismiss()
    }

    private func announce(_ saved: [Item]) {
        var toast = Toast(text: "Saved \(saved.count) items", systemImage: "checkmark.circle.fill")
        if saved.count == 1, let item = saved.first {
            toast.text = "Saved “\(String(item.displayTitle.prefix(40)))”"
            toast.actionLabel = "Open"
            let router = self.router
            toast.action = { router.open(item) }
        }
        library.show(toast)
    }

    /// Multipart fields for file uploads: strings, "true" for flags, comma-separated lists.
    private static func formFields(_ fields: [String: JSONValue]) -> [String: String] {
        var out: [String: String] = [:]
        for (k, v) in fields {
            switch v {
            case .string(let s): out[k] = s
            case .bool(let b): out[k] = b ? "true" : ""
            case .array(let list):
                var parts: [String] = []
                for case .string(let s) in list { parts.append(s) }
                out[k] = parts.joined(separator: ",")
            default: break
            }
        }
        return out
    }
}

/// A video picked from Photos, copied to our temp folder.
struct PickedMovie: Transferable {
    let file: UploadFile

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { movie in
            SentTransferredFile(movie.file.url)
        } importing: { received in
            PickedMovie(file: try UploadFile.stage(from: received.file))
        }
    }
}
