import SwiftUI

/// Ask a question and get an answer written from your saved items, with sources.
struct AskView: View {
    var initialQuestion: String?
    @Environment(Library.self) private var library
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @State private var input = ""
    @State private var asking = false
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 28) {
                        if router.askTurns.isEmpty { intro }
                        ForEach(router.askTurns) { turn in
                            TurnView(turn: turn, asking: asking && turn.id == router.askTurns.last?.id) { item in
                                dismiss()
                                router.open(item)
                            }
                            .id(turn.id)
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.vertical, 16)
                    .frame(maxWidth: 720)
                    .frame(maxWidth: .infinity)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: router.askTurns.count) { _, _ in
                    if let last = router.askTurns.last { withAnimation { proxy.scrollTo(last.id, anchor: .top) } }
                }
            }
            .safeAreaInset(edge: .bottom) { inputBar }
            .navigationTitle("Ask Trove")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if !router.askTurns.isEmpty, !asking {
                        Button("Clear") { withAnimation { router.askTurns = [] } }
                    }
                }
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.fontWeight(.semibold) }
            }
            .onAppear {
                if let q = initialQuestion, !q.isEmpty, router.askTurns.last?.question != q {
                    ask(q)
                } else {
                    focused = router.askTurns.isEmpty
                }
            }
        }
    }

    private var intro: some View {
        VStack(alignment: .leading, spacing: 18) {
            Image(systemName: "sparkles")
                .font(.system(size: 30, weight: .medium))
                .foregroundStyle(Color.accentColor)
                .frame(width: 60, height: 60)
                .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            VStack(alignment: .leading, spacing: 6) {
                Text("Ask your library").font(.title2.bold())
                Text("Answers come from what you’ve saved, with links to the sources.")
                    .foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 8) {
                ForEach(suggestions, id: \.self) { s in
                    Button { ask(s) } label: {
                        HStack {
                            Text(s).multilineTextAlignment(.leading)
                            Spacer()
                            Image(systemName: "arrow.up.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 12)
                        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.top, 4)
        }
        .padding(.top, 12)
    }

    private var suggestions: [String] {
        var out = ["What have I saved recently that I should read first?"]
        for tag in library.tagNames.prefix(2) { out.append("Summarize what I saved about \(tag)") }
        out.append("Which videos did I save about design?")
        return out
    }

    private var inputBar: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextField("Ask a question", text: $input, axis: .vertical)
                .lineLimit(1...5)
                .focused($focused)
                .submitLabel(.send)
                .onSubmit { ask(input) }
                .padding(.horizontal, 16)
                .padding(.vertical, 11)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            Button { ask(input) } label: {
                Image(systemName: "arrow.up")
                    .font(.body.weight(.bold))
                    .foregroundStyle(.white)
                    .frame(width: 40, height: 40)
                    .background(Circle().fill(input.trimmingCharacters(in: .whitespaces).isEmpty || asking ? Color.secondary.opacity(0.4) : Color.accentColor))
            }
            .disabled(input.trimmingCharacters(in: .whitespaces).isEmpty || asking)
            .accessibilityLabel("Ask")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private func ask(_ raw: String) {
        let q = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty, !asking, let api = library.api else { return }
        input = ""
        focused = false
        asking = true
        let turn = Router.AskTurn(question: q)
        withAnimation(.snappy) { router.askTurns.append(turn) }
        Task {
            defer { asking = false }
            do {
                let r = try await api.ask(q)
                update(turn.id) { $0.result = r }
            } catch {
                if library.handleAuth(error) { return }
                update(turn.id) { $0.error = error.localizedDescription }
            }
        }
    }

    private func update(_ id: UUID, _ change: (inout Router.AskTurn) -> Void) {
        guard let i = router.askTurns.firstIndex(where: { $0.id == id }) else { return }
        withAnimation(.snappy) { change(&router.askTurns[i]) }
    }
}

private struct TurnView: View {
    let turn: Router.AskTurn
    let asking: Bool
    let onOpen: (Item) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(turn.question)
                .font(.title3.weight(.semibold))
                .textSelection(.enabled)
            if let result = turn.result {
                AnswerText(markdown: result.answer, sources: result.sources, onOpen: onOpen)
                if !result.sources.isEmpty {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Sources")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .textCase(.uppercase)
                            .padding(.bottom, 4)
                        ForEach(Array(result.sources.enumerated()), id: \.element.id) { n, item in
                            Button { onOpen(item) } label: {
                                HStack(spacing: 10) {
                                    Text("\(n + 1)")
                                        .font(.caption.weight(.bold).monospacedDigit())
                                        .foregroundStyle(Color.accentColor)
                                        .frame(width: 22, height: 22)
                                        .background(Color.accentColor.opacity(0.12), in: Circle())
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(item.displayTitle).font(.subheadline.weight(.medium)).lineLimit(2)
                                        MetaLine(item: item)
                                    }
                                    Spacer(minLength: 0)
                                    Thumbnail(item: item, side: 40, corner: 8)
                                }
                                .padding(.vertical, 8)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(14)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
            } else if let error = turn.error {
                let friendly = Self.explain(error)
                VStack(alignment: .leading, spacing: 6) {
                    Label(friendly.title, systemImage: "exclamationmark.triangle.fill")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.orange)
                    Text(friendly.detail)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            } else if asking {
                ThinkingView()
            }
        }
    }
}

extension TurnView {
    /// Server errors in plain words (the free AI allowance runs out daily).
    static func explain(_ error: String) -> (title: String, detail: String) {
        let e = error.lowercased()
        if e.contains("allowance") || e.contains("neurons") || e.contains("quota") {
            var c = Calendar(identifier: .gregorian)
            c.timeZone = TimeZone(identifier: "UTC")!
            let reset = c.nextDate(after: .now, matching: DateComponents(hour: 0, minute: 0), matchingPolicy: .nextTime) ?? .now
            let hours = max(1, Int(reset.timeIntervalSinceNow / 3600))
            return ("Trove’s AI is resting", "Today’s free AI allowance is used up. It resets in about \(hours) h (00:00 UTC). Search still works.")
        }
        if e.contains("needs ai") || e.contains("ai is off") {
            return ("AI isn’t set up", "Asking needs AI on your Trove server. Search still works.")
        }
        return ("Couldn’t answer", error)
    }
}

private struct ThinkingView: View {
    @State private var phase = false

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "sparkles")
                .foregroundStyle(Color.accentColor)
                .symbolEffect(.pulse, options: .repeating)
            Text("Reading your library…")
                .foregroundStyle(.secondary)
        }
        .font(.subheadline)
        .padding(.vertical, 6)
    }
}

/// The answer's Markdown, with [n] citations turned into links to the sources.
private struct AnswerText: View {
    let markdown: String
    let sources: [Item]
    let onOpen: (Item) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .heading(let s):
                    Text(attributed(s)).font(.headline).padding(.top, 4)
                case .bullet(let s, let marker):
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(marker).foregroundStyle(.secondary).monospacedDigit()
                        Text(attributed(s))
                    }
                case .paragraph(let s):
                    Text(attributed(s))
                }
            }
        }
        .font(.body)
        .lineSpacing(3)
        .textSelection(.enabled)
        .environment(\.openURL, OpenURLAction { url in
            if url.scheme == "trove-source", let n = Int(url.host() ?? ""), n >= 1, n <= sources.count {
                onOpen(sources[n - 1])
                return .handled
            }
            LinkOpener.open(url)
            return .handled
        })
    }

    private enum Block { case heading(String), bullet(String, String), paragraph(String) }

    private var blocks: [Block] {
        var out: [Block] = []
        var number = 0
        for raw in markdown.components(separatedBy: "\n") {
            let t = raw.trimmingCharacters(in: .whitespaces)
            if t.isEmpty { number = 0; continue }
            if t.hasPrefix("#") {
                out.append(.heading(String(t.drop(while: { $0 == "#" })).trimmingCharacters(in: .whitespaces)))
            } else if t.hasPrefix("- ") || t.hasPrefix("* ") {
                out.append(.bullet(String(t.dropFirst(2)), "•"))
            } else if let dot = t.firstIndex(of: "."), t[..<dot].allSatisfy(\.isNumber), !t[..<dot].isEmpty, t[t.index(after: dot)...].hasPrefix(" ") {
                number += 1
                out.append(.bullet(String(t[t.index(dot, offsetBy: 2)...]), "\(number)."))
            } else {
                out.append(.paragraph(t))
            }
        }
        return out
    }

    private func attributed(_ s: String) -> AttributedString {
        var text = s
        if let re = try? NSRegularExpression(pattern: #"\[(\d{1,2})\](?!\()"#) {
            text = re.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: "[[$1]](trove-source://$1)")
        }
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        var a = (try? AttributedString(markdown: text, options: options)) ?? AttributedString(s)
        for run in a.runs where run.link?.scheme == "trove-source" {
            a[run.range].foregroundColor = .accentColor
            a[run.range].font = .footnote.weight(.semibold)
        }
        return a
    }
}
