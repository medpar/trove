import SwiftUI

struct EditItemView: View {
    let item: Item
    @Environment(Library.self) private var library
    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var collection: String?
    @State private var tags: [String]
    @State private var note: String
    @State private var favorite: Bool
    @State private var isRead: Bool
    @State private var hasReminder: Bool
    @State private var reminder: Date

    init(item: Item) {
        self.item = item
        _title = State(initialValue: item.title)
        _collection = State(initialValue: item.collection)
        _tags = State(initialValue: item.tags)
        _note = State(initialValue: item.note)
        _favorite = State(initialValue: item.favorite)
        _isRead = State(initialValue: item.read)
        _hasReminder = State(initialValue: item.remind != nil)
        _reminder = State(initialValue: TroveDate.parse(item.remind) ?? Calendar.current.date(byAdding: .day, value: 1, to: .now)!)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Title", text: $title, axis: .vertical)
                        .font(.body.weight(.semibold))
                        .lineLimit(1...4)
                    if !item.url.isEmpty {
                        Label(item.url.replacingOccurrences(of: "https://", with: ""), systemImage: "link")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Section {
                    NavigationLink {
                        CollectionPicker(selection: $collection, allowsNone: true)
                    } label: {
                        LabeledContent {
                            Text(collection.map { $0.replacingOccurrences(of: "/", with: " › ") } ?? "Unsorted")
                                .lineLimit(1)
                        } label: {
                            Label("Collection", systemImage: "folder")
                        }
                    }
                    TagField(tags: $tags, suggestions: library.tagNames)
                }
                Section("Note") {
                    TextField("Why you saved it, what to remember…", text: $note, axis: .vertical)
                        .lineLimit(3...12)
                }
                Section {
                    Toggle(isOn: $favorite) { Label("Favorite", systemImage: "heart") }
                    Toggle(isOn: $isRead) { Label("Read", systemImage: "checkmark.circle") }
                    Toggle(isOn: $hasReminder.animation()) { Label("Remind Me", systemImage: "alarm") }
                    if hasReminder {
                        DatePicker("Date", selection: $reminder, displayedComponents: .date)
                    }
                }
            }
            .navigationTitle("Edit Details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", action: save)
                        .fontWeight(.semibold)
                }
            }
        }
    }

    private func save() {
        var patch: [String: JSONValue] = [:]
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if !t.isEmpty, t != item.title { patch["title"] = .string(t) }
        if collection != item.collection { patch["collection"] = .string(collection ?? "") }
        if tags != item.tags { patch["tags"] = .strings(tags) }
        if note != item.note { patch["note"] = .string(note) }
        if favorite != item.favorite { patch["favorite"] = .bool(favorite) }
        if isRead != item.read { patch["read"] = .bool(isRead) }
        let remind = hasReminder ? TroveDate.dayString(reminder) : nil
        if remind != item.remind.map({ String($0.prefix(10)) }) { patch["remind"] = remind.map { .string($0) } ?? .null }
        dismiss()
        guard !patch.isEmpty else { return }
        let (newTitle, newCollection, newTags, newNote, fav, readNow) = (t.isEmpty ? item.title : t, collection, tags, note, favorite, isRead)
        Task {
            await library.update(item, server: patch) {
                $0.title = newTitle
                $0.collection = newCollection
                $0.tags = newTags
                $0.note = newNote
                $0.favorite = fav
                $0.read = readNow
                $0.remind = remind
            }
        }
    }
}

// MARK: - Collection picker

struct CollectionPicker: View {
    @Binding var selection: String?
    var allowsNone = true
    var noneLabel = "Unsorted"
    @Environment(Library.self) private var library
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""

    var body: some View {
        let names = library.collectionNames
        let q = search.trimmingCharacters(in: .whitespaces)
        let filtered = q.isEmpty ? names : names.filter { $0.localizedCaseInsensitiveContains(q) }
        List {
            if !q.isEmpty, !names.contains(where: { $0.caseInsensitiveCompare(q) == .orderedSame }) {
                Button { choose(q) } label: {
                    Label("New collection “\(q)”", systemImage: "folder.badge.plus")
                }
            }
            if allowsNone, q.isEmpty {
                row(nil, label: noneLabel, icon: "tray", depth: 0)
            }
            ForEach(filtered, id: \.self) { name in
                let depth = q.isEmpty ? name.filter { $0 == "/" }.count : 0
                row(name, label: q.isEmpty ? String(name.split(separator: "/").last ?? "") : name.replacingOccurrences(of: "/", with: " › "), icon: "folder", depth: depth)
            }
        }
        .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .always), prompt: "Find or create a collection")
        .navigationTitle("Collection")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func row(_ value: String?, label: String, icon: String, depth: Int) -> some View {
        Button { choose(value) } label: {
            HStack {
                Label(label, systemImage: icon)
                    .padding(.leading, CGFloat(depth) * 18)
                    .foregroundStyle(.primary)
                Spacer()
                if selection == value {
                    Image(systemName: "checkmark").foregroundStyle(Color.accentColor).fontWeight(.semibold)
                }
            }
        }
    }

    private func choose(_ value: String?) {
        selection = value
        dismiss()
    }
}

// MARK: - Tags

/// Tag chips with a field to add more, suggesting tags you already use.
struct TagField: View {
    @Binding var tags: [String]
    var suggestions: [String]
    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Tags", systemImage: "number")
            if !tags.isEmpty {
                FlowLayout(spacing: 6) {
                    ForEach(tags, id: \.self) { tag in
                        Button {
                            withAnimation(.snappy) { tags.removeAll { $0 == tag } }
                        } label: {
                            HStack(spacing: 4) {
                                Text("#\(tag)")
                                Image(systemName: "xmark").font(.caption2.weight(.bold)).foregroundStyle(.secondary)
                            }
                            .font(.subheadline)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .background(Color.accentColor.opacity(0.12), in: Capsule())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Remove tag \(tag)")
                    }
                }
            }
            TextField("Add a tag", text: $draft)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($focused)
                .submitLabel(.done)
                .onSubmit { add(draft); focused = true }
                .onChange(of: draft) { _, v in
                    if v.hasSuffix(",") || v.hasSuffix(" ") { add(String(v.dropLast())) }
                }
            let matches = matching
            if !matches.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(matches, id: \.self) { s in
                            Button("#\(s)") { add(s) }
                                .font(.subheadline)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 5)
                                .background(Color(.tertiarySystemFill), in: Capsule())
                                .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }

    private var matching: [String] {
        let q = draft.trimmingCharacters(in: .whitespaces).lowercased()
        let pool = suggestions.filter { !tags.contains($0) }
        return Array((q.isEmpty ? (focused ? pool : []) : pool.filter { $0.lowercased().contains(q) }).prefix(8))
    }

    private func add(_ raw: String) {
        let t = raw.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "#,")).lowercased()
        draft = ""
        guard !t.isEmpty, !tags.contains(t) else { return }
        withAnimation(.snappy) { tags.append(t) }
    }
}

/// Wraps children onto new lines, like text.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, maxX: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > 0, x + s.width > width {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            x += s.width + spacing
            maxX = max(maxX, x - spacing)
            rowHeight = max(rowHeight, s.height)
        }
        return CGSize(width: min(maxX, width), height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > bounds.minX, x + s.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            v.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(s))
            x += s.width + spacing
            rowHeight = max(rowHeight, s.height)
        }
    }
}
